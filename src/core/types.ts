/**
 * THE CONTRACT.
 *
 * Every type that crosses a module boundary in ashlr-hub lives here.
 * Downstream agents (git, classify, index-engine, tidy, cli, raycast)
 * import from this file and MUST NOT redefine these shapes.
 */

/** A single tidy rule: how to match a file/dir and where it should go. */
export interface TidyRule {
  /** Glob, regex source, or bare extension depending on `matchType`. */
  match: string;
  /** How `match` is interpreted: shell glob, RegExp source, or file extension. */
  matchType: 'glob' | 'regex' | 'ext';
  /** Destination directory (relative to root or absolute) the match moves into. */
  dest: string;
  /** Optional human-readable explanation of the rule's intent. */
  description?: string;
}

/** Persisted configuration for the hub. Lives at ~/.ashlr/config.json. */
export interface AshlrConfig {
  /** Schema/config version for forward migration. */
  version: number;
  /** Absolute roots to scan (typically the Desktop and github/). */
  roots: string[];
  /** Preferred editor for deep links. */
  editor: 'cursor' | 'vscode';
  /** Days without modification before an item is considered stale/inactive. */
  staleDays: number;
  /** Map of category name -> absolute folder path (e.g. "dev-tools" -> ".../github/dev-tools"). */
  categories: Record<string, string>;
  /** Ordered tidy rules applied to loose top-level files. */
  tidyRules: TidyRule[];
  /** Absolute paths or basenames that must never be moved/tidied. */
  keepers: string[];
  /** Local + remote model configuration and provider preference order. */
  models: {
    lmstudio: string;
    ollama: string;
    providerChain: string[];
    /**
     * Optional per-task routing rules (M15). Each rule maps a goal/task match
     * to a preferred model. First matching rule wins; falls back to local-first
     * chain selection when none match. Never forces a cloud provider on its own.
     */
    routing?: RoutingRule[];
    /**
     * Optional auto-escalation policy (M15). When `onFailure` is true, a LOCAL
     * task that fails/verify-fails (or exceeds `latencyMs`) MAY escalate to a
     * cloud provider for one routed retry — but ONLY when --allow-cloud is set
     * and a cloud key is present. Never enables silent cloud spend on its own.
     */
    escalate?: { onFailure: boolean; latencyMs?: number };
    /**
     * M41: enable the model-adaptive prompt suite (Fable-5-grade layered
     * system prompts + per-model profiles for verbosity / step-cap /
     * temperature). Default OFF — when absent/false the harness uses its
     * legacy prompts and step cap unchanged. Overridable per-process via the
     * ASHLR_ADAPTIVE_PROMPTS env var.
     */
    adaptivePrompts?: boolean;
    /**
     * M41: optional per-profile overrides keyed by profile id
     * ('coder' | 'general' | 'small' | 'default'). Shallow-merged onto the
     * built-in ModelProfile. Power-user knob; absent by default.
     */
    profiles?: Record<string, Partial<import('./run/model-profile.js').ModelProfile>>;
  };
  /** Telemetry hooks (e.g. Pulse) + local budget caps. All fields optional. */
  telemetry: {
    pulse?: string;
    /** Optional spend cap (USD) for the budget window; alerts when over/near. */
    budgetUsd?: number;
    /** Optional token cap (in + out) for the budget window. */
    budgetTokens?: number;
    /** Window the budget caps apply to (default '7d' when caps are set). */
    budgetWindow?: "1d" | "7d" | "30d";
    /**
     * M19 spend governance action when the period spend exceeds the cap.
     * 'warn' (default): advisory only — print a prominent warning, never block.
     * 'block': additionally require an explicit --over-budget flag to proceed.
     * Governance NEVER silently blocks; the per-run hard budget remains the
     * only hard ceiling.
     */
    govAction?: "warn" | "block";
  };
  /** Map of integration name -> resolved executable path (entire, aw, claude, ...). */
  tools: Record<string, string>;
  /** Optional Phantom secrets integration toggle. */
  phantom?: { enabled: boolean };
  /**
   * Shared-memory / genome settings (M7). Controls recall limits and whether
   * the orchestrator injects recall hits into sub-agent prompts.
   */
  genome?: {
    /** Max number of recall hits returned/injected (default 5). */
    maxRecall: number;
    /** Whether `ashlr run` injects top-k recall into sub-agent prompts (default true). */
    injectOnRun: boolean;
    /**
     * Whether a completed run/swarm auto-captures a summary GenomeEntry (M16).
     * Default true. Summary/metadata only; fire-and-forget; opt out per-call
     * via --no-capture. Never blocks/slows a run.
     */
    autoCapture?: boolean;
    /**
     * Whether `runGoal` synthesizes + injects a bounded playbook from past
     * similar entries into planning context (M16). Default true.
     */
    playbookOnRun?: boolean;
  };
  /**
   * Optional outward notification targets (M18). When a webhook is set, a
   * concise run/swarm COMPLETION summary MAY be posted to it (no secrets).
   * Entirely opt-in: a no-op when unset — notify() never posts without one.
   */
  notify?: NotifyTarget;
  /**
   * M45: multi-backend engine fleet (v4 Foundry). ENTIRELY OPT-IN — when absent,
   * behavior is unchanged (builtin only; external engines run raw as today).
   * When present, external engines run SANDBOXED with diff capture and the fleet
   * may route work across the allowed backends.
   */
  foundry?: {
    /** Backends the fleet may use. Absent ⇒ ['builtin'] only. */
    allowedBackends?: EngineId[];
    /** Per-backend preferred model id (keyed by EngineId). */
    models?: Partial<Record<EngineId, string>>;
    /** Run external engines inside a sandbox with diff capture (default true when foundry set). */
    sandboxExternal?: boolean;
    /** Hard wall-clock per external run (ms). Default 20 min. */
    timeoutMs?: number;
    /**
     * Allowlist for the (later) merge-authority gate: a proposal may auto-apply
     * to main only if its {engine,model} matches an entry here. Defined now,
     * enforced in a later milestone.
     */
    mergeAuthority?: Array<{ engine: EngineId; model: string }>;
    /**
     * M46: per-backend rate limits for subscription backends (flat-fee, rate-
     * limited — not token-billed). Keyed by EngineId. `window` is a label like
     * '1m'|'5m'|'1h'|'1d'; `max` is the max dispatches per rolling window.
     * Absent ⇒ unlimited. Used by the fleet scheduler (M46/M48).
     */
    limits?: Partial<Record<EngineId, { window: string; max: number }>>;
    /**
     * M50 (v5): declarative engine roster. Each entry overrides a builtin
     * engine spec or adds a new backend (cli-agent or OpenAI-compatible
     * api-model), keyed by engine id. Merged over BUILTIN_ENGINE_REGISTRY by
     * `resolveEngineRegistry`. Absent ⇒ exactly the builtin roster. This is the
     * config-only path to adding a backend — no code branch.
     */
    engines?: Record<string, EngineSpec>;
    /**
     * M53: fleet-intelligence tuning. Absent ⇒ learned routing / budget recovery
     * / anomaly holds are OFF (the daemon routes exactly as M46/M48). All actions
     * stay proposal-only — this only tunes WHICH backend/tier and WHEN to hold.
     */
    intelligence?: {
      /** Anomaly threshold k: a run costing > k × p50 is held + a TuningProposal filed (default 4). */
      anomalyK?: number;
      /** Min verified-success rate below which a class is nudged off frontier (0..1, default 0.5). */
      minFrontierSuccessRate?: number;
    };
    /**
     * M47: tiered-trust auto-merge to main. DEFAULT DISABLED. When enabled, a
     * proposal may be merged to the default branch ONLY when ALL hold: it is
     * frontier merge-authority (engineTier 'frontier' + {engine,model} ∈
     * mergeAuthority), its risk class is ≤ maxRisk, and full verification passes.
     * Kill-switch and human override always apply; nothing auto-merges by default.
     */
    autoMerge?: {
      enabled: boolean;
      /** Max risk class permitted to auto-merge (default 'low'). */
      maxRisk?: 'low' | 'medium' | 'high';
      /** Also merge/push on the remote (gh pr merge) when applying (default false). */
      pushToRemote?: boolean;
      /**
       * M56 (v5): permit MID-tier (strong open model) proposals to auto-apply
       * to a BRANCH / PR — never to `main`. Separate, DEFAULT-OFF sub-flag, so
       * enabling main auto-merge does not implicitly enable the branch path.
       */
      midToBranch?: boolean;
      /** Permit auto-merge when NO verification commands are detected (default false = fail-closed). */
      allowWithoutVerification?: boolean;
    };
    /**
     * M52: per-engine OS-level confinement profiles. DEFAULT ABSENT (v4 env-only).
     * When present, external engine spawns are wrapped with a platform-native
     * read-jail (macOS sandbox-exec, Linux bwrap) that confines file reads to the
     * worktree + vendor config homes and optionally blocks network egress.
     * A `*` key sets a fleet-wide default; per-engine keys override it.
     * Absent ⇒ exactly v4 behavior (env-only containment, no OS jail).
     */
    confinement?: Partial<Record<EngineId | '*', {
      /** 'off' (v4 env-only, default) | 'os' (wrap spawn in an OS jail). */
      mode?: 'off' | 'os';
      /** Extra absolute paths the agent may READ beyond the worktree + vendor homes. */
      readAllowed?: string[];
      /** Allow outbound network from the contained process (default false). */
      networkEgress?: boolean;
      /**
       * When mode 'os' but the platform has no jail binary: 'fallback' (env-only,
       * audited) | 'fail' (terminal). Default 'fallback'.
       */
      onUnsupported?: 'fallback' | 'fail';
    }>>;
  };
  /**
   * M24: optional autonomous-operator (daemon) tuning. When unset, the daemon
   * falls back to its hard-coded conservative defaults. This NEVER widens the
   * daemon's authority — the daemon is proposal-only by construction; these
   * fields only bound HOW MUCH it may propose (budget/items/parallel/interval).
   */
  daemon?: Partial<DaemonConfig>;
  /**
   * M33: optional plugin-system configuration. Additive — absent in old configs
   * and defaults to { enabled: [], settings: {}, integrity: {} } via defaultConfig().
   * DEFAULT EMPTY: enabled:[] means NO plugins load.
   */
  plugins?: {
    /** Plugin names that are permitted to load (default empty = load nothing). */
    enabled: string[];
    /** Per-plugin key/value settings. Key = plugin name, value = arbitrary object. */
    settings: Record<string, Record<string, unknown>>;
    /**
     * Per-plugin integrity pins. Key = plugin name.
     * Value = "sha256:<64-hex-char>" hash of the plugin's entry file.
     * A missing pin causes the plugin to be refused at load time.
     */
    integrity: Record<string, string>;
  };
  /**
   * M89: Fleet→Pulse OTLP exporter. When enabled, the daemon emits fleet
   * activity (ticks + proposals) as OTLP/JSON spans to ashlr-pulse after
   * each tick. Auth via ASHLR_PULSE_PAT env var (never stored in config).
   * DEFAULT DISABLED — no telemetry is sent without explicit opt-in.
   */
  pulse?: {
    /** Enable fleet→pulse OTLP export (default false). */
    enabled?: boolean;
    /** OTLP endpoint base URL (default 'http://localhost:3000'). */
    endpoint?: string;
  };
}

// ---------------------------------------------------------------------------
// M2: identity & model awareness contract
// ---------------------------------------------------------------------------

/** Result of probing a single local-model/provider endpoint. Never throws. */
export interface ProviderEndpoint {
  /** Stable provider id ('lmstudio' | 'ollama' | custom). */
  id: 'lmstudio' | 'ollama' | string;
  /** Base/probe URL that was queried. */
  url: string;
  /** Whether the endpoint responded successfully. */
  up: boolean;
  /** Model ids/names reported by the endpoint (empty when down). */
  models: string[];
  /** Probe error message when `up` is false, else absent. */
  error?: string;
}

/** Aggregated view of all configured providers + the resolved active one. */
export interface ProviderRegistry {
  /** All probed endpoints, in chain order where possible. */
  providers: ProviderEndpoint[];
  /** Id of the first up provider in the chain, or null if none are up. */
  activeProvider: string | null;
  /** The configured provider preference chain (from cfg.models.providerChain). */
  chain: string[];
}

/** Read-only status of the Phantom secrets CLI. NEVER carries secret values. */
export interface PhantomStatus {
  /** Whether the `phantom` binary is on PATH. */
  installed: boolean;
  /** Reported version string, or null if unknown/unavailable. */
  version: string | null;
  /** Whether a Phantom vault/identity is initialized. */
  initialized: boolean;
  /** Secret NAMES only (never values). Empty when uninitialized/unavailable. */
  secretNames: string[];
  /** Error message when status could not be fully determined, else absent. */
  error?: string;
}

/** Outcome of a single doctor health check. */
export type DoctorCheckStatus = 'pass' | 'warn' | 'fail';

/** A single health check produced by `runDoctor`. */
export interface DoctorCheck {
  /** Stable check id (e.g. 'config', 'phantom', 'provider:ollama'). */
  id: string;
  /** Human-readable label for the check. */
  label: string;
  /** pass | warn | fail. */
  status: DoctorCheckStatus;
  /** One-line detail describing the observed state. */
  detail: string;
  /** Optional suggested remediation command/hint. */
  fix?: string;
}

/** Full one-glance health report from `ashlr doctor`. */
export interface DoctorReport {
  /** ISO timestamp the report was generated. */
  generatedAt: string;
  /** All checks performed, in display order. */
  checks: DoctorCheck[];
  /** Roll-up counts by status. */
  summary: { pass: number; warn: number; fail: number };
}

/** What an indexed entry fundamentally is. */
export type ItemKind = 'repo' | 'doc-folder' | 'doc' | 'asset' | 'symlink' | 'other';

/** Git working-tree + remote-tracking summary for a repo. */
export interface GitStatus {
  /** Current branch name (or detached HEAD label). */
  branch: string;
  /** Count of dirty (modified/staged/untracked) paths. */
  dirty: number;
  /** Commits ahead of upstream. */
  ahead: number;
  /** Commits behind upstream. */
  behind: number;
  /** ISO timestamp of the last commit, or null if no commits yet. */
  lastCommit: string | null;
}

/** A single thing on the Desktop that the hub knows about. */
export interface IndexedItem {
  /** Stable identifier (derived from the absolute path). */
  id: string;
  /** Display name (basename). */
  name: string;
  /** Absolute filesystem path. */
  path: string;
  /** Fundamental kind of the item. */
  kind: ItemKind;
  /** Category bucket (e.g. "dev-tools", "Business"), or null if uncategorized. */
  category: string | null;
  /** One-line description (README h1 / package.json description), or null. */
  description: string | null;
  /** Git org parsed from the remote (ashlrai, masonwyatt23, ...), or null. */
  org: string | null;
  /** Raw git remote URL, or null. */
  remote: string | null;
  /** Primary language guess, or null. */
  language: string | null;
  /** ISO timestamp of last modification. */
  lastModified: string;
  /** Whether the item is "active" (modified within staleDays). */
  active: boolean;
  /** Size in bytes, when cheaply available. */
  sizeBytes?: number;
  /** Git status, present only for repos. */
  git?: GitStatus;
  /** Resolved target path, present only for symlinks. */
  linkTarget?: string;
}

/** The full on-disk index. Lives at ~/.ashlr/index.json. */
export interface AshlrIndex {
  /** Index format version. */
  version: number;
  /** ISO timestamp the index was generated. */
  generatedAt: string;
  /** Absolute root the index was built from (informational). */
  root: string;
  /** All indexed items. */
  items: IndexedItem[];
}

/** A single planned move during tidy. */
export interface TidyMove {
  /** Absolute source path. */
  from: string;
  /** Absolute destination path. */
  to: string;
  /** Identifier/description of the rule that produced this move. */
  rule: string;
}

/** The output of planning a tidy pass (dry run). */
export interface TidyPlan {
  /** Moves that would be applied. */
  moves: TidyMove[];
  /** Paths intentionally not moved, with a reason (keeper, no-match, etc.). */
  skipped: { path: string; reason: string }[];
}

// ---------------------------------------------------------------------------
// M3: MCP aggregation gateway + ecosystem tools registry contract
// ---------------------------------------------------------------------------

/** A single discovered MCP server spec (one entry under an "mcpServers" map). */
export interface McpServerSpec {
  /** Unique server name (dedupe key across all discovered configs). */
  name: string;
  /** Executable to launch the stdio MCP server. */
  command: string;
  /** Arguments passed to `command`. */
  args: string[];
  /** Environment overrides for the child process. Values redacted when printed. */
  env?: Record<string, string>;
  /** Where this spec was discovered (config path / logical source label). */
  source: string;
}

/** All MCP servers discovered on this machine, deduped by name. */
export interface McpRegistry {
  /** Discovered server specs in stable order. */
  servers: McpServerSpec[];
}

/** One downstream tool surfaced through the gateway, namespaced for routing. */
export interface AggregatedTool {
  /** Owning downstream server name. */
  server: string;
  /** Original (downstream) tool name. */
  name: string;
  /** Gateway-facing name: `<server>__<tool>`. */
  namespaced: string;
  /** Tool description as reported by the downstream, if any. */
  description?: string;
}

/** Health probe result for a single downstream MCP server. */
export interface McpServerHealth {
  /** Server name probed. */
  name: string;
  /** Whether the server started and listed its tools successfully. */
  ok: boolean;
  /** Number of tools the server exposes (0 when not ok). */
  toolCount: number;
  /** Tool names reported by the server (empty when not ok). */
  tools: string[];
  /** Failure reason when `ok` is false, else absent. */
  error?: string;
}

/** Detection result for a single ecosystem CLI tool. */
export interface ToolInfo {
  /** Stable tool id (e.g. 'phantom', 'ashlr-plugin', 'stack'). */
  id: string;
  /** Display name for the tool. */
  name: string;
  /** Whether the tool was found on PATH. */
  installed: boolean;
  /** Reported version string, or null if unknown/not installed. */
  version: string | null;
  /** Resolved executable path, or null if not installed. */
  path: string | null;
}

/** Roll-up of all detected ecosystem tools. */
export interface ToolsRegistry {
  /** All probed tools in display order. */
  tools: ToolInfo[];
  /** Count of tools where `installed` is true. */
  installedCount: number;
}

// ---------------------------------------------------------------------------
// M4: local-first agent orchestrator (`ashlr run`) contract
// ---------------------------------------------------------------------------

/** Hard guardrails for a single run. Budget/steps abort the run when exceeded. */
export interface RunBudget {
  /** Maximum total tokens (in + out) before the run aborts. */
  maxTokens: number;
  /** Maximum number of model/agent steps before the run aborts. */
  maxSteps: number;
  /** Whether cloud providers are permitted (default false = local-first refuse). */
  allowCloud: boolean;
}

/** Token + step accounting for a task or whole run. */
export interface RunUsage {
  /** Prompt/input tokens consumed. */
  tokensIn: number;
  /** Completion/output tokens produced. */
  tokensOut: number;
  /** Number of steps taken. */
  steps: number;
  /** Estimated USD cost (0 for local providers). */
  estCostUsd: number;
}

/** Lifecycle state of a single task in the run graph. */
export type RunTaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

/** A single node in the run task-graph (DAG). */
export interface RunTask {
  /** Stable task id (unique within the run). */
  id: string;
  /** The sub-goal this task must accomplish. */
  goal: string;
  /** Ids of tasks that must complete before this one runs. */
  deps: string[];
  /** Current lifecycle status. */
  status: RunTaskStatus;
  /** Final task result text, present when done. */
  result?: string;
  /** Token/step usage attributed to this task. */
  usage?: RunUsage;
  /** Failure reason when status is 'failed', else absent. */
  error?: string;
}

/** An append-only event recorded during a run for audit/resume. */
export interface RunStep {
  /** ISO timestamp the step occurred. */
  ts: string;
  /** Id of the task this step belongs to. */
  taskId: string;
  /** What kind of step this was. */
  kind: 'plan' | 'model' | 'tool' | 'synthesize';
  /** One-line human-readable summary of the step. */
  summary: string;
  /** Usage incurred by this step, if any. */
  usage?: RunUsage;
}

/** Full persisted state of a run. Lives at ~/.ashlr/runs/<id>.json. */
export interface RunState {
  /** Stable run id. */
  id: string;
  /** The original top-level goal. */
  goal: string;
  /** Engine that executed the run ('builtin' | 'ashlrcode' | 'aw' | 'claude' | 'codex'). */
  engine: string;
  /** Active provider id used for the run. */
  provider: string;
  /**
   * M45: backend + model that produced this run, for merge-authority gating.
   * e.g. 'claude:claude-opus-4-8' | 'codex:gpt-5.5' | 'builtin:<local-model>'.
   */
  engineModel?: string;
  /** M45: trust tier of the producing backend ('local' | 'frontier'). */
  engineTier?: EngineTier;
  /** ISO timestamp the run was created. */
  createdAt: string;
  /** ISO timestamp of the last update (written after each step). */
  updatedAt: string;
  /** Guardrails in effect for this run. */
  budget: RunBudget;
  /** Cumulative usage across the whole run. */
  usage: RunUsage;
  /** The task-graph (DAG). */
  tasks: RunTask[];
  /** Append-only step log. */
  steps: RunStep[];
  /** Current run status. */
  status: 'running' | 'done' | 'aborted' | 'failed';
  /** Synthesized final answer, present when done. */
  result?: string;
}

/** Options accepted by `runGoal` / the `ashlr run` CLI. */
export interface RunOptions {
  /** Partial budget overrides (merged over defaults). */
  budget?: Partial<RunBudget>;
  /** Max independent tasks to execute in parallel. */
  parallel?: number;
  /** Engine selector ('builtin' | 'ashlrcode' | 'aw'). */
  engine?: string;
  /** Whether to load aggregated MCP tools (default true). */
  tools?: boolean;
  /** Whether cloud providers are permitted. */
  allowCloud?: boolean;
  /**
   * Absolute working directory the run operates in (e.g. a swarm task's target
   * project dir). When set, engine delegation uses this as the spawn cwd so the
   * agent acts WITHIN the intended project, not wherever the parent launched.
   * Defaults to process.cwd() when unset.
   */
  cwd?: string;
  /** Existing run id to resume from cache. */
  resumeId?: string;
  /** Emit machine-readable JSON instead of human output. */
  json?: boolean;
  /** Disable genome recall injection into the sub-agent system prompt (M7). */
  noMemory?: boolean;
  /**
   * Enable the optional cheap MODEL verification check after each builtin task
   * (M11). Default false → heuristic-only verification (no extra model calls,
   * preserving deterministic usage accounting). When true, verifyTask may make
   * one cheap model call per task plus one verify-driven retry, all bounded by
   * the global budget.
   */
  verifyModel?: boolean;
  /**
   * M42: enable the in-process engineering tool surface — read_file/glob/grep
   * plus sandboxed write_file/edit_file (and, with allowBash, bash/run_tests).
   * Default false → the run keeps today's spec-only gateway tools and never
   * writes. All writes land in a throwaway git worktree; the captured diff is
   * routed to the approval inbox as a PENDING proposal, never the live tree.
   */
  engineer?: boolean;
  /** M42: additionally enable the bash/run_tests exec tools (requires engineer). */
  allowBash?: boolean;
  /**
   * M43: max verify→repair iterations per task on a failing structured verify
   * (typecheck/test/lint). Default 2; 0 disables the repair loop. Each iteration
   * is bounded by the per-task step cap and the global budget.
   */
  maxRepairs?: number;
  /**
   * M45: when true, an external engine ('claude'|'codex'|…) runs INSIDE a
   * throwaway sandbox worktree with its diff captured to the inbox, instead of
   * raw on the live tree. Set by the swarm/daemon for autonomous external runs.
   */
  sandboxEngine?: boolean;
  /** M45: abort (no raw fallback) if a sandbox worktree cannot be created. */
  requireSandbox?: boolean;
}

/** A single message in a chat exchange with a provider. */
export interface ChatMessage {
  /** Message author role. */
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** Message text content. */
  content: string;
  /** Tool-call id this message responds to (for role 'tool'). */
  toolCallId?: string;
  /** Tool/function name (for role 'tool'). */
  name?: string;
}

/** Result of a single chat completion call. */
export interface ChatResult {
  /** Assistant text content (may be empty when only tool calls returned). */
  content: string;
  /** Tool calls the model requested, if any. */
  toolCalls?: { id: string; name: string; arguments: unknown }[];
  /** Token accounting for this call. */
  usage: { tokensIn: number; tokensOut: number };
}

/** Thin chat client over the active local provider (Ollama / LM Studio). */
export interface ProviderClient {
  /** Provider id this client targets. */
  id: string;
  /**
   * Resolved model name this client serves (M41). Optional/additive — plugin
   * providers may omit it. Used to resolve a model-adaptive ModelProfile.
   */
  model?: string;
  /** Whether the underlying model/provider supports tool calls. */
  supportsTools: boolean;
  /** Send a chat exchange (optionally with tool specs) and get a result. */
  chat(messages: ChatMessage[], tools?: unknown[]): Promise<ChatResult>;
  /**
   * Streaming chat (M11): invoke `onDelta(textChunk)` for each incremental
   * content token, resolving to the SAME ChatResult shape as `chat()`
   * (final content + toolCalls + usage). Implementations fall back to `chat()`
   * (emitting the full content via a single `onDelta`) when the provider/model
   * does not support streaming or streaming errors.
   *
   * Optional at the type level so the M11 contract typechecks before the
   * provider agent implements it; the provider agent makes it concrete on both
   * the Ollama and LM Studio clients (callers must `?.`-guard until then).
   */
  chatStream?(
    messages: ChatMessage[],
    tools: unknown[] | undefined,
    onDelta: (t: string) => void,
  ): Promise<ChatResult>;
}

// ---------------------------------------------------------------------------
// M5: local-first observability (cost / tokens / activity) contract
// ---------------------------------------------------------------------------

/**
 * One normalized usage data point. METADATA ONLY — never carries message
 * content. Sourced from Claude Code transcripts ('claude') or local agent
 * runs ('run').
 */
export interface UsageEvent {
  /** ISO timestamp of the event. */
  ts: string;
  /** Absolute project path this usage belongs to, or null if unknown. */
  project: string | null;
  /** Model id that produced the usage. */
  model: string;
  /** Where the event came from. */
  source: "claude" | "run";
  /** Prompt/input tokens. */
  tokensIn: number;
  /** Completion/output tokens. */
  tokensOut: number;
  /** Cache-read input tokens (0 when unavailable). */
  cacheRead: number;
  /** Cache-creation (write) input tokens (0 when unavailable). */
  cacheWrite: number;
}

/** Per-project activity roll-up within a window. */
export interface ProjectActivity {
  /** Absolute project path (or label). */
  project: string;
  /** Number of distinct sessions attributed to the project. */
  sessions: number;
  /** Number of git commits in the window. */
  commits: number;
  /** Total input tokens. */
  tokensIn: number;
  /** Total output tokens. */
  tokensOut: number;
  /** Estimated USD cost. */
  estCostUsd: number;
  /** ISO timestamp of the most recent activity, or null. */
  lastActive: string | null;
}

/** Per-day usage roll-up within a window. */
export interface DailyUsage {
  /** Calendar day (YYYY-MM-DD). */
  day: string;
  /** Total input tokens for the day. */
  tokensIn: number;
  /** Total output tokens for the day. */
  tokensOut: number;
  /** Estimated USD cost for the day. */
  estCostUsd: number;
  /** Number of sessions active that day. */
  sessions: number;
}

/** Per-model usage roll-up within a window. */
export interface ModelUsage {
  /** Model id. */
  model: string;
  /** Total input tokens. */
  tokensIn: number;
  /** Total output tokens. */
  tokensOut: number;
  /** Estimated USD cost. */
  estCostUsd: number;
  /** Number of calls attributed to the model. */
  calls: number;
}

/** Budget evaluation for a spend/token cap over a window. */
export interface BudgetAlert {
  /** ok (under), warn (near cap), or over (exceeded). */
  level: "ok" | "warn" | "over";
  /** Window the alert applies to (e.g. '7d'). */
  window: string;
  /** USD spent in the window. */
  spentUsd: number;
  /** Configured USD cap, or null if none set. */
  capUsd: number | null;
  /** Tokens (in + out) spent in the window. */
  spentTokens: number;
  /** Configured token cap, or null if none set. */
  capTokens: number | null;
  /** Human-readable status message. */
  message: string;
}

/** The full observability roll-up for a window. */
export interface ActivityRollup {
  /** Window label (e.g. '1d' | '7d' | '30d'). */
  window: string;
  /** ISO timestamp marking the start of the window. */
  since: string;
  /** Window totals across all projects/models. */
  totals: {
    tokensIn: number;
    tokensOut: number;
    estCostUsd: number;
    sessions: number;
    commits: number;
  };
  /** Per-project breakdown, sorted by activity. */
  byProject: ProjectActivity[];
  /** Per-day breakdown, ascending by day. */
  byDay: DailyUsage[];
  /** Per-model breakdown, sorted by cost/tokens. */
  byModel: ModelUsage[];
  /** Budget evaluation for the window. */
  budget: BudgetAlert;
}

// ---------------------------------------------------------------------------
// M6: project lifecycle (scaffold `ashlr new` + pre-ship gate `ashlr ship`)
// ---------------------------------------------------------------------------

/** A single file emitted by a project template. */
export interface TemplateFile {
  /** Path relative to the project root (POSIX-style separators). */
  path: string;
  /** Full file contents to write. */
  content: string;
  /** Optional octal file mode (e.g. 0o755 for executables). */
  mode?: number;
}

/** A complete agentic-engineering starter template. */
export interface ProjectTemplate {
  /** Stable template id (e.g. 'node-cli', 'mcp-server', 'next-app', 'minimal'). */
  id: string;
  /** Display title for the template. */
  title: string;
  /** One-line description of what the template scaffolds. */
  description: string;
  /** Produce the template's files for a given project name + category. */
  files(ctx: { name: string; category: string }): TemplateFile[];
}

/** Fully-resolved instructions for a single scaffold operation. */
export interface ScaffoldSpec {
  /** Project name (basename of the new directory). */
  name: string;
  /** Category bucket (e.g. 'side-projects', 'dev-tools'). */
  category: string;
  /** Id of the template to scaffold from. */
  templateId: string;
  /** Absolute target directory (must not already exist). */
  dir: string;
  /** Whether to run `git init` in the new project. */
  git: boolean;
  /** Optional `stack` recipe id to provision after scaffolding. */
  stackRecipe?: string;
  /**
   * Opt out of the in-tree write guard that confines scaffolding to
   * ~/Desktop/github (or the cwd for --here). ONLY for hermetic tests that
   * scaffold into os.tmpdir(). Never set by the CLI for real scaffolds.
   */
  allowAnyRoot?: boolean;
}

/** Outcome of a scaffold operation. Never throws; failure is reported here. */
export interface ScaffoldResult {
  /** Whether the project was scaffolded successfully. */
  ok: boolean;
  /** Absolute directory the project was (or would be) created in. */
  dir: string;
  /** Absolute paths of files written. */
  filesWritten: string[];
  /** Whether `git init` ran successfully. */
  gitInitialized: boolean;
  /** Whether the ashlr MCP gateway was wired into .mcp.json. */
  mcpWired: boolean;
  /** Whether the project was registered in the index. */
  registered: boolean;
  /** Error message when `ok` is false, else absent. */
  error?: string;
  /** Non-fatal warnings collected during scaffolding. */
  warnings: string[];
}

/** A single pre-ship gate check. */
export interface ShipCheck {
  /** Stable check id (e.g. 'supply-chain', 'test', 'lint', 'build'). */
  id: string;
  /** Human-readable label for the check. */
  label: string;
  /** pass | warn | fail | skip. */
  status: 'pass' | 'warn' | 'fail' | 'skip';
  /** One-line detail describing the observed state. */
  detail: string;
  /** Optional suggested remediation command/hint. */
  fix?: string;
}

/** The full pre-ship gate report. */
export interface ShipGate {
  /** All checks performed, in display order. */
  checks: ShipCheck[];
  /** Roll-up counts by status. */
  summary: { pass: number; warn: number; fail: number; skip: number };
  /** Whether the gate passed overall (no fails, or non-strict). */
  passed: boolean;
}

/** Outcome of `ashlr ship`: the gate plus optional (dry-run) deploy. */
export interface ShipResult {
  /** The pre-ship gate report. */
  gate: ShipGate;
  /** Deploy target name, or null when no deploy was requested. */
  deployTarget: string | null;
  /** Whether the deploy was a dry-run (true unless --confirm passed). */
  deployDryRun: boolean;
  /** Whether the deploy actually ran (only when confirmed). */
  deployRan: boolean;
  /** Human-readable detail of what was (or would be) deployed. */
  deployDetail: string;
}

// ---------------------------------------------------------------------------
// M7: shared memory / genome (cross-project, local-first) contract
// ---------------------------------------------------------------------------

/**
 * A single unit of shared memory in the aggregated genome. Sourced either
 * from a per-project `.ashlrcode/genome/` directory ('project') or from the
 * hub store at ~/.ashlr/genome/hub.jsonl ('hub'). User's own notes/summaries
 * only — never carries secrets.
 */
export interface GenomeEntry {
  /** Stable identifier (derived from content/source; unique within the aggregate). */
  id: string;
  /** Project name this entry belongs to, or null when not project-scoped. */
  project: string | null;
  /** Where the entry came from. */
  source: 'project' | 'hub';
  /** Short human-readable title/heading for the entry. */
  title: string;
  /** Body text of the memory (the actual note/summary). */
  text: string;
  /** Free-form tags for filtering/grouping. */
  tags: string[];
  /** ISO timestamp the entry was created/learned. */
  ts: string;
}

/** A single recall result: a genome entry plus its relevance score + method. */
export interface RecallHit {
  /** The matched genome entry. */
  entry: GenomeEntry;
  /** Relevance score (higher is more relevant). */
  score: number;
  /** How the score was computed. */
  method: 'keyword' | 'embedding';
}

/** Status/health roll-up for the aggregated genome (`ashlr genome`). */
export interface GenomeHealth {
  /** Total entries across all sources (project + hub). */
  totalEntries: number;
  /** Number of distinct projects covered by the genome. */
  projects: number;
  /** Number of entries in the hub store (~/.ashlr/genome/hub.jsonl). */
  hubEntries: number;
  /** Total size in bytes of the hub store on disk. */
  sizeBytes: number;
  /** ISO timestamp of the most recently learned entry, or null if empty. */
  lastLearnedAt: string | null;
  /** Whether a local embedding-capable model is available for reranking. */
  embeddingsAvailable: boolean;
}

/** Input accepted by `ashlr learn` / `appendHubEntry`. */
export interface LearnInput {
  /** Body text of the memory to store (required). */
  text: string;
  /** Optional short title/heading (derived from text when omitted). */
  title?: string;
  /** Optional project name to scope the entry to. */
  project?: string;
  /** Optional tags to attach to the entry. */
  tags?: string[];
  /**
   * When true, append to the hub store ONLY — never drop a note file into the
   * resolved project's `.ashlrcode/genome/hub-notes/` working tree. M16
   * auto-capture sets this so a completed run/swarm never emits a file inside
   * the user's repo (which could be git-committed); the project-note drop is
   * reserved for explicit `genome --teach` / `learn`.
   */
  hubOnly?: boolean;
}

// ---------------------------------------------------------------------------
// M10: config -> env bridge (ecosystem cohesion) contract
// ---------------------------------------------------------------------------

/**
 * A flat map of environment-variable name -> value. Used by the env-bridge
 * (core/env-bridge.ts) to project the unified ~/.ashlr/config.json into the
 * environment of spawned ecosystem tools. NON-SECRET ONLY — endpoints, model
 * names, paths, and flags. Never carries secret VALUES (phantom owns secrets).
 */
export type ToolEnv = Record<string, string>;

// ---------------------------------------------------------------------------
// M11: watchable, robust agent foundation (streaming + retry + verify +
// hardened engine delegation + phantom-exec) contract
// ---------------------------------------------------------------------------

/**
 * A single live event emitted during a run so the CLI can stream progress to
 * the user as it happens (model deltas, task lifecycle, tool calls, retries,
 * verification, free-form logs) instead of only printing at the end.
 *
 * METADATA + USER-FACING TEXT ONLY — never carries secret values.
 */
export interface RunStreamEvent {
  /** What kind of event this is. */
  kind: 'task-start' | 'model-delta' | 'tool-call' | 'task-done' | 'retry' | 'verify' | 'log';
  /** Id of the task this event belongs to, when applicable. */
  taskId?: string;
  /** Human-readable / model-delta text payload, when applicable. */
  text?: string;
  /** Structured payload (e.g. tool args, verdict, usage), when applicable. */
  data?: unknown;
  /** ISO timestamp the event was emitted. */
  ts: string;
}

/** Bounded retry policy for a single task. Caps attempts and backoff base. */
export interface RetryPolicy {
  /** Maximum number of attempts (>=1; total tries including the first). */
  maxAttempts: number;
  /** Base delay in ms for exponential backoff between attempts. */
  baseDelayMs: number;
}

/** Verdict from verifying that a task result plausibly satisfies its goal. */
export interface VerifyVerdict {
  /** Whether the result is judged to satisfy the task goal. */
  ok: boolean;
  /** One-line human-readable reason for the verdict. */
  reason: string;
  /** How the verdict was reached. */
  method: 'heuristic' | 'model' | 'command';
}

/** The set of engines `ashlr run` can delegate to (or run locally). */
export type EngineId =
  | 'builtin'
  | 'ashlrcode'
  | 'aw'
  | 'claude'
  | 'codex'
  | 'hermes'
  | 'opencode';

/**
 * M45: trust tier of the backend that produced work. 'frontier' = a
 * merge-authority model (e.g. Opus 4.8 via Claude Code, GPT-5.5 via Codex);
 * 'local' = an on-device model. Only 'frontier' work may auto-merge to main
 * (enforced later via cfg.foundry.mergeAuthority).
 */
export type EngineTier = 'local' | 'mid' | 'frontier';

/** A fully-resolved external engine invocation (exact argv + optional cwd). */
export interface EngineCommand {
  /** Executable to spawn (e.g. 'claude', 'aw', 'ac', or 'phantom' when wrapped). */
  bin: string;
  /** Exact argument vector passed to `bin`. */
  args: string[];
  /** Working directory for the spawned process, when set. */
  cwd?: string;
}

/**
 * M50 (v5): the kind of a backend engine.
 *  - 'builtin'   — the in-process local agent loop (no external CLI).
 *  - 'cli-agent' — an external agent CLI spawned + contained (claude, codex, …).
 *  - 'api-model' — an OpenAI-compatible API endpoint driven through the run loop.
 */
export type EngineKind = 'builtin' | 'cli-agent' | 'api-model';

/**
 * M50 (v5): one segment of a declarative argv template. A plain string is a
 * literal argv element, EXCEPT the exact tokens '$GOAL' | '$CWD' | '$MODEL',
 * which are substituted (each as a SINGLE argv element — never shell-split, so a
 * goal containing '$CWD' or ';' is passed verbatim and never expanded). An
 * `{ optModel }` segment is emitted only when a concrete model is present.
 */
export type ArgvSeg = string | { optModel: string[] };

/**
 * M50 (v5): a declarative backend engine specification. The registry
 * (`run/engine-registry.ts`) is the single source of truth for how an engine is
 * invoked, probed, and trust-tiered. Adding a backend is a config-only
 * `cfg.foundry.engines` entry that reuses this shape — no code branch.
 */
export interface EngineSpec {
  /** Stable engine id (matches an EngineId for builtins; any string for additions). */
  id: string;
  /** How this engine is driven. */
  kind: EngineKind;
  /** Trust tier; only 'frontier' carries merge-to-main authority. */
  tier: EngineTier;
  /** Executable name for a cli-agent (defaults to id when omitted). */
  bin?: string;
  /** PATH probe candidates (engineInstalled); defaults to [bin ?? id]. */
  bins?: string[];
  /** Base argv template (cli-agent). */
  argv?: ArgvSeg[];
  /** Extra argv appended when running unattended/autonomous. */
  autonomousArgv?: ArgvSeg[];
  /** OpenAI-compatible API wiring (api-model). */
  api?: {
    envKey: string;
    baseUrlEnv?: string;
    defaultBaseUrl?: string;
    defaultModel?: string;
    protocol: 'openai';
  };
  /** Free-form capability tags used by capability-aware routing. */
  capabilities?: string[];
}

// ---------------------------------------------------------------------------
// M12: contracts-first swarm — end-state specs (`ashlr spec`) + fleet runner
// (`ashlr swarm`). Specs are first-class versioned artifacts; a swarm
// decomposes a spec into a contracts-first DAG of phases and runs a bounded
// fleet of local-first agents through them.
// ---------------------------------------------------------------------------

/**
 * A first-class, versioned END-STATE SPEC artifact. The markdown body lives at
 * <project>/.ashlr/specs/<slug>-v<N>.md with this sidecar metadata alongside
 * it as <slug>-v<N>.json. Versioning is never destructive: refining produces
 * a new version (v+1) rather than overwriting.
 */
export interface SpecArtifact {
  /** Stable spec id (slug derived from the goal; shared across versions). */
  id: string;
  /** The original authoring goal/prompt for the spec. */
  goal: string;
  /** Monotonic version number (1-based; refine produces v+1). */
  version: number;
  /** Absolute project path the spec is scoped to, or null when global. */
  project: string | null;
  /** Absolute path to the markdown body file for this version. */
  path: string;
  /** Lifecycle status of the spec. */
  status: 'draft' | 'active' | 'archived';
  /** ISO timestamp the spec (this version) was created. */
  createdAt: string;
  /** ISO timestamp the spec was last updated. */
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// M17: verified + unattended-safe swarms — signing, escalation, rollback.
// ---------------------------------------------------------------------------

/**
 * Tamper-evident signature over a swarm task's output.
 * Contains ONLY hashes — never any payload secret. `hash` is a content digest
 * of the signed text; `sig` is the keyed signature (HMAC or phantom-derived).
 * `alg` records how it was produced; 'phantom' uses a phantom-sourced key
 * best-effort, 'hmac-sha256' uses the local auto-generated key.
 */
export interface OutputSignature {
  /** Signing algorithm / key source. */
  alg: 'hmac-sha256' | 'phantom';
  /** Content digest (hex) of the signed text. */
  hash: string;
  /** Keyed signature (hex) over the content. NEVER a secret value. */
  sig: string;
  /** Opaque signer identity (e.g. 'local' or a phantom key id) — no secrets. */
  signer: string;
  /** ISO timestamp the signature was produced. */
  ts: string;
}

/** Why a swarm escalation gate tripped. */
export type EscalationReasonKind =
  | 'verify-failed'
  | 'over-budget'
  | 'tamper'
  | 'risk'
  | 'low-confidence';

/**
 * A single escalation gate trip. The swarm persists this and STOPS
 * (status 'needs-approval'); only an explicit `ashlr swarm approve <id>` resumes.
 */
export interface EscalationEvent {
  /** Task that triggered the gate, or null for swarm-level (e.g. over-budget). */
  taskId: string | null;
  /** Which gate tripped. */
  kind: EscalationReasonKind;
  /** Human-readable explanation (no secrets). */
  detail: string;
  /** ISO timestamp the gate tripped. */
  ts: string;
}

/**
 * Read-only git snapshot of a project, taken before a swarm operates in it.
 * Used by the CONFIRM-gated `ashlr swarm rollback <id>`. NEVER carries secrets.
 */
export interface RollbackSnapshot {
  /** Absolute project path, or null when the swarm has no project. */
  project: string | null;
  /** Whether `project` is a git repository. */
  isRepo: boolean;
  /** Recorded HEAD commit sha, or null when not a repo / unresolved. */
  head: string | null;
  /**
   * Branch name HEAD pointed at when the snapshot was taken, or null when HEAD
   * was already detached / unresolved. Used so a non-force rollback can return
   * the repo to the original branch rather than leaving it in detached HEAD.
   */
  branch?: string | null;
  /** Whether the working tree was dirty at snapshot time. */
  dirty: boolean;
  /** Ref/name of the stash holding the dirty tree, or null when clean/none. */
  stashRef: string | null;
  /** ISO timestamp the snapshot was taken. */
  ts: string;
}

/** The ordered phases of a contracts-first swarm. */
export type SwarmPhaseName = 'scaffold' | 'build' | 'integrate' | 'verify' | 'review';

/** A single planned task within a swarm phase (a unit of agent work). */
export interface SwarmTaskSpec {
  /** Stable task id (unique within the swarm). */
  id: string;
  /** Which phase this task belongs to. */
  phase: SwarmPhaseName;
  /** The sub-goal this task must accomplish. */
  goal: string;
  /** Ids of tasks that must complete before this one runs. */
  deps: string[];
}

/** Execution state of a single swarm task. */
export interface SwarmTaskRun {
  /** Stable task id (matches its SwarmTaskSpec.id). */
  id: string;
  /** Which phase this task belongs to. */
  phase: SwarmPhaseName;
  /** Current lifecycle status. */
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  /** Final task result text, present when done. */
  result?: string;
  /** Token/step usage attributed to this task. */
  usage?: RunUsage;
  /** Failure reason when status is 'failed', else absent. */
  error?: string;
  /**
   * M17: tamper-evident signature over this task's `result`, computed when the
   * task completes. Downstream tasks verify this before consuming the output.
   */
  signature?: OutputSignature;
  /**
   * M17: set true when a human explicitly approved this task past an escalation
   * gate via `ashlr swarm approve <id>`. The runner SKIPS re-scanning this
   * task's goal-risk on the resumed run so an approved goal-risk escalation
   * does not re-trip the same gate and loop forever. Cleared/absent otherwise.
   */
  approved?: boolean;
}

/** The planned swarm: a decomposition of a goal/spec into phased tasks. */
export interface SwarmPlan {
  /** Source spec id this plan derives from, or null when goal-only. */
  specId: string | null;
  /** The top-level goal the swarm pursues. */
  goal: string;
  /** All planned tasks across phases (caps tasks per phase <= 6). */
  tasks: SwarmTaskSpec[];
}

/** Full persisted state of a swarm. Lives at ~/.ashlr/swarms/<id>.json. */
export interface SwarmRun {
  /** Stable swarm id. */
  id: string;
  /** The original top-level goal. */
  goal: string;
  /** Source spec id, or null when goal-only. */
  specId: string | null;
  /** Absolute project path the swarm operates in, or null. */
  project: string | null;
  /** ISO timestamp the swarm was created. */
  createdAt: string;
  /** ISO timestamp of the last update (written after each step). */
  updatedAt: string;
  /** HARD total guardrails in effect across the whole swarm. */
  budget: RunBudget;
  /** Cumulative usage across all tasks (sum of per-task usage). */
  usage: RunUsage;
  /** Bounded concurrency for the parallel BUILD phase. */
  parallel: number;
  /**
   * Current swarm status. M17 adds 'needs-approval': the swarm PAUSED at an
   * escalation gate and STOPPED; an explicit `ashlr swarm approve <id>` resumes it.
   */
  status: 'planning' | 'running' | 'done' | 'aborted' | 'failed' | 'needs-approval';
  /** The planned decomposition. */
  plan: SwarmPlan;
  /** Per-task execution state, in plan order. */
  tasks: SwarmTaskRun[];
  /** Aggregated final result/summary, present when done. */
  result?: string;
  /**
   * M17: ordered log of escalation gate trips. Each entry records why the swarm
   * paused (verify-failed, over-budget, tamper, risk, low-confidence). Append-only.
   */
  escalations?: EscalationEvent[];
  /**
   * M17: read-only git snapshot of the project taken before the swarm operated
   * in it. Drives the CONFIRM-gated `ashlr swarm rollback <id>`. Absent if the
   * swarm has no project or the project is not a git repo.
   */
  rollback?: RollbackSnapshot;
}

/** Options accepted by `runSwarm` / the `ashlr swarm` CLI. */
export interface SwarmOptions {
  /** Partial budget overrides (merged over defaults) — the HARD total ceiling. */
  budget?: Partial<RunBudget>;
  /** Bounded concurrency for the BUILD phase (default 3, max 8). */
  parallel?: number;
  /** Launch a detached background worker and return the swarm id immediately. */
  background?: boolean;
  /** Existing swarm id to resume from persisted state. */
  resumeId?: string;
  /** Plan only — produce the SwarmPlan without executing any task. */
  dryRun?: boolean;
  /** Permit cloud providers for tasks (default false = local-first). */
  allowCloud?: boolean;
  /** Absolute target project directory the swarm operates in. */
  project?: string;
  /**
   * M17: when set alongside resumeId, resumes a swarm paused in 'needs-approval'
   * — set ONLY by `ashlr swarm approve <id>` (explicit human action). Threads the
   * approval into the runner so a goal-risk escalation can actually be cleared
   * (the runner skips re-scanning approved tasks). Never set on a fresh run.
   */
  approved?: boolean;
  /**
   * M21: when true, the swarm runs inside an isolated git-worktree sandbox
   * (created under ~/.ashlr/sandboxes/) instead of the user's working tree.
   * SEAM ONLY — plumbed here so a future daemon (M24) can wire it; defaults to
   * OFF, in which case the swarm behaves exactly as it does today.
   */
  sandbox?: boolean;
  /**
   * M24: when true (alongside sandbox), the swarm's captured patch is recorded
   * as a PENDING inbox proposal rather than left as a bare worktree diff. SEAM
   * ONLY — grants NO outward authority: a PENDING proposal is applied LATER only
   * by an explicit human `inbox approve`. Defaults to OFF.
   */
  propose?: boolean;
  /**
   * M24: when true (alongside sandbox), the sandbox is MANDATORY — if the
   * isolated git-worktree cannot be created (worktree module absent, source is
   * not a git repo, HEAD unresolvable, `git worktree add` fails, or a kill-switch
   * race), the swarm ABORTS with status 'failed' and executes ZERO tasks rather
   * than silently falling back to the user's working tree. The autonomous daemon
   * ALWAYS sets this so its work can NEVER touch a real repo's working tree.
   * Defaults to OFF (preserves the legacy non-strict fallback for non-daemon callers).
   */
  requireSandbox?: boolean;
}

// ---------------------------------------------------------------------------
// M13: surfaces I — watchable hub (interactive TUI + real-time Raycast).
// A bounded, read-only aggregate snapshot drives an auto-refreshing terminal
// dashboard (`ashlr tui` / `ashlr dash`) and feeds the Raycast views.
// ---------------------------------------------------------------------------

/**
 * A single bounded, read-only aggregate of the whole hub at one instant.
 * Built from index/git, runs, swarms, the observability rollup, MCP health,
 * the ecosystem tools registry, and genome health. Drives every TUI tab and
 * the Raycast surfaces. NEVER throws — missing/unavailable sources degrade to
 * zeroed/empty fields. METADATA ONLY — never carries secret values.
 */
export interface DashboardSnapshot {
  /** ISO timestamp the snapshot was generated. */
  generatedAt: string;
  /** Repo roll-up: total indexed repos, dirty working trees, stale/inactive. */
  repos: { total: number; dirty: number; stale: number };
  /** Ecosystem tools roll-up: installed vs. total probed. */
  tools: { installed: number; total: number };
  /** Activity roll-up over the dashboard window (sessions/tokens/cost/commits). */
  activity: { sessions: number; tokens: number; estCostUsd: number; commits: number };
  /** Recent runs (most-recent first), each with status + cumulative tokens. */
  runs: { id: string; goal: string; status: string; tokens: number }[];
  /** Active/recent swarms with live task burndown + optional current phase. */
  swarms: {
    id: string;
    goal: string;
    status: string;
    tasksDone: number;
    tasksTotal: number;
    phase?: string;
  }[];
  /** MCP server health: name, reachable/ok, and tool count. */
  mcp: { name: string; ok: boolean; tools: number }[];
  /** Genome roll-up: total entries and distinct projects covered. */
  genome: { entries: number; projects: number };
  /** M23: number of proposals awaiting Mason's approval in the inbox gate. */
  inbox: { pending: number };
  /**
   * M24: autonomous-operator (daemon) roll-up. `running` reflects daemon state;
   * `todaySpentUsd` is the operator's spend so far today (resets per day);
   * `pendingProposals` mirrors inbox.pending for the daemon surface. READ-ONLY
   * — surfacing daemon status NEVER applies a proposal or mutates a repo.
   * Optional so existing snapshot producers stay valid until the M24 surface
   * populates it; absent => treat as not running / no daemon spend.
   */
  daemon?: { running: boolean; todaySpentUsd: number; pendingProposals: number };
  /**
   * M29: OPTIONAL org-level portfolio roll-up. ABSENT on existing producers /
   * tests (so they stay valid); populated by buildSnapshot when the v2 sources
   * are present. READ-ONLY aggregation over already-local state — health (M27,
   * ENROLLMENT-SCOPED via computeReport), in-flight goals (M28), top backlog
   * (M22), cost+forecast (M19 rollup/forecast over the local index), and the
   * effectiveness headline (M26 reflect). Each sub-source degrades to its
   * empty/zeroed default on failure; an empty enrollment leaves the
   * enrollment-scoped sections empty with NO portfolio disk scan.
   */
  portfolio?: PortfolioSummary;
}

/**
 * The selectable tabs of the interactive TUI dashboard.
 *
 * M29 adds 'portfolio' — a READ-ONLY org-level surface rendered from the
 * optional `DashboardSnapshot.portfolio` section (health summary, in-flight
 * goals, top backlog, cost+forecast, effectiveness headline, and a "today"
 * delta block). The tab renders nothing destructive; it only displays the
 * already-aggregated read-only snapshot.
 */
export type TuiTab = 'overview' | 'runs' | 'swarms' | 'pulse' | 'mcp' | 'inbox' | 'portfolio';


// ---------------------------------------------------------------------------
// M14: surfaces II — local web dashboard served by the hub (`ashlr serve`).
// A localhost-only HTTP server (Node 'http' builtin, ZERO new runtime deps,
// NO CDN — all assets bundled in the repo and served locally) exposes a
// read-only JSON API + Server-Sent-Events live stream and a hand-built static
// SPA. SECURITY: binds 127.0.0.1 ONLY; Host-header allowlist (anti DNS-
// rebinding); read-only by default; the single mutating route (POST /api/run)
// exists ONLY under --allow-dispatch and is per-session-token-guarded.
// METADATA ONLY — never serves secret values.
// ---------------------------------------------------------------------------

/** Options controlling how the local web dashboard server starts. */
export interface WebServerOptions {
  /** TCP port to bind on 127.0.0.1 (default chosen by the CLI, e.g. 7777). */
  port: number;
  /** Whether to open the default browser to the served URL after start. */
  open: boolean;
  /**
   * Whether to expose the guarded, token-protected mutating dispatch route
   * (POST /api/run). When false (the default), the server has NO mutating
   * endpoints — read-only API + SSE + static assets only.
   */
  allowDispatch: boolean;
}

/** A handle to a running web dashboard server. Returned by `startServer`. */
export interface WebServerHandle {
  /** The actual port the server bound on 127.0.0.1. */
  port: number;
  /**
   * Per-session secret token. Printed by `ashlr serve` and REQUIRED (in a
   * request header) for the guarded POST /api/run dispatch route. Defeats
   * CSRF / drive-by POSTs. Empty/unused when allowDispatch is false.
   */
  token: string;
  /** The localhost URL the dashboard is served at (e.g. http://127.0.0.1:7777). */
  url: string;
  /** Stop the server cleanly (closes listeners + bounded SSE pollers). */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// M15: cost-optimal, local-first model routing. A per-task router picks the
// cheapest viable provider+model (LOCAL by default); cloud is reachable ONLY
// via --allow-cloud + a present API key + an escalation reason. Cost is
// attributed per provider (local=$0), with a "would-have-been-cloud"
// comparison and a simple monthly forecast. `ashlr models` lists/manages
// local models (opt-in pull/start only). NEVER auto-downloads or auto-spends.
// ---------------------------------------------------------------------------

/** Whether a routed model runs LOCALLY (Ollama/LM Studio) or in the CLOUD. */
export type ModelTier = 'local' | 'cloud';

/** The router's decision for a single task attempt: which provider+model + why. */
export interface RouteDecision {
  /** Provider id the task should run on (e.g. 'ollama', 'lmstudio', 'anthropic'). */
  provider: string;
  /** Concrete model id/name to use on that provider. */
  model: string;
  /** Whether this route is local-first ($0) or an escalated cloud route. */
  tier: ModelTier;
  /** One-line human-readable explanation of why this route was chosen. */
  reason: string;
}

/** A single per-task routing rule: match a goal/task to a preferred model. */
export interface RoutingRule {
  /** Match expression against the task goal (substring/keyword/kind label). */
  match: string;
  /** Preferred model id/name when the rule matches. */
  model: string;
}

/** Why a task escalated (or 'none' when it is a normal first-attempt route). */
export type EscalationReason = 'task-failed' | 'verify-failed' | 'latency' | 'none';

/** A single local model discovered on Ollama or LM Studio. */
export interface LocalModelInfo {
  /** Which local provider exposes this model. */
  provider: 'ollama' | 'lmstudio';
  /** Model name/id as reported by the provider's /api/tags (or equivalent). */
  name: string;
  /** Optional human-readable size label (e.g. '4.7 GB'), when available. */
  sizeLabel?: string;
  /** Whether this is the active/default model for its provider. */
  active: boolean;
}

/** Cost attribution + forward forecast for a recent usage window (M15). */
export interface CostForecast {
  /** Window label the forecast is built from (e.g. '7d' | '30d'). */
  window: string;
  /** Actual USD spent in the window (local providers contribute $0). */
  spentUsd: number;
  /**
   * Estimated USD that the SAME local tokens WOULD have cost on cloud — the
   * savings from staying local. Clearly an estimate, never fabricated precision.
   */
  localSavingsUsd: number;
  /** Simple projected monthly USD spend extrapolated from the window's rate. */
  projectedMonthlyUsd: number;
}

// ---------------------------------------------------------------------------
// M16: compounding genome. Completed runs/swarms auto-capture a SUMMARY-only
// GenomeEntry (fire-and-forget, never blocks/throws, dedupe-aware). Near-
// duplicate entries can be consolidated (backup-first, provenance-preserving,
// never lossy). Past entries are synthesized into a bounded playbook injected
// into planning. The genome is exportable (no lock-in). PRIVACY: metadata/
// summary only — never secrets, full prompts/completions, tool args, or file
// contents. LOCAL-ONLY: no cloud calls; synthesis uses the local provider
// best-effort with a concatenated-recall fallback.
// ---------------------------------------------------------------------------

/**
 * The summary-only payload captured from a completed run/swarm (or an explicit
 * teach) before it is appended to the genome. METADATA/SUMMARY ONLY — never
 * carries secrets, raw prompts/completions, tool args, or file contents.
 */
export interface GenomeCapture {
  /** The top-level goal the run/swarm pursued (or the teach note's subject). */
  goal: string;
  /** Absolute project path this capture is scoped to, or null when global. */
  project: string | null;
  /** Concise approach/outcome summary (capped length; secret-free). */
  summary: string;
  /** Tags for filtering/grouping (e.g. project, status, engine, source). */
  tags: string[];
  /** Terminal outcome of the work being captured. */
  outcome: 'done' | 'aborted' | 'failed';
  /** Where the capture originated. */
  source: 'run' | 'swarm' | 'teach';
}

/**
 * A synthesized "how we've approached this before" playbook for a goal: the
 * recalled past entries plus a concise synthesis of what worked / what failed
 * / cost. Bounded; injected into planning context. LOCAL synthesis with a
 * concatenated-recall fallback.
 */
export interface Playbook {
  /** The goal the playbook was built for. */
  goal: string;
  /** The recalled past entries the playbook synthesizes (ranked). */
  entries: RecallHit[];
  /** Concise synthesized guidance (what worked / failed / cost), or fallback. */
  synthesis: string;
}

/**
 * Outcome of `ashlr genome consolidate`. A timestamped backup of hub.jsonl is
 * written BEFORE any merge; near-duplicate entries are merged into canonical
 * entries that preserve provenance (count + first/last seen + merged tags) so
 * information is never irrecoverably dropped.
 */
export interface ConsolidationResult {
  /** Entry count before consolidation. */
  before: number;
  /** Entry count after consolidation. */
  after: number;
  /** Number of entries merged away into canonical entries. */
  merged: number;
  /** Absolute path of the timestamped hub.jsonl backup written first. */
  backupPath: string;
}

/* ---------------------------------------------------------------------------
 * M18 — outward integrations (GitHub, Vercel, identity, notifications).
 * All READ shapes; producers reuse the installed CLIs (gh/vercel/phantom),
 * never handle raw tokens, and read-only producers must never throw.
 * ------------------------------------------------------------------------- */

/**
 * Read-only snapshot of the current repo's GitHub state (M18), derived from
 * the `gh` CLI. Surfaced in `ashlr status` when cwd is a gh repo. Never thrown
 * from a producer — degrades to a safe "not a repo / unknown" shape instead.
 */
export interface GithubStatus {
  /** Whether cwd resolves to a GitHub repo reachable via `gh`. */
  isRepo: boolean;
  /** Count of open pull requests (0 when unknown/not a repo). */
  openPrs: number;
  /** Count of open issues (0 when unknown/not a repo). */
  openIssues: number;
  /** Aggregate CI/checks state for the default/most-recent ref. */
  ci: 'passing' | 'failing' | 'pending' | 'none';
  /** "owner/name" of the repo, or null when not a repo / unresolved. */
  repo: string | null;
}

/**
 * Read-only snapshot of the linked Vercel project's latest deploy (M18),
 * derived from the `vercel` CLI. Surfaced in `ashlr status` when a project is
 * linked. Producer must never throw — degrades to an "unlinked" shape.
 */
export interface VercelStatus {
  /** Whether a Vercel project is linked for cwd. */
  linked: boolean;
  /** Latest deployment build state (e.g. "READY", "BUILDING"), or null. */
  latestState: string | null;
  /** Latest preview/deploy URL, or null when none/unlinked. */
  url: string | null;
}

/**
 * Read-only caller identity (M18), derived from `phantom` cloud status/team.
 * NAMES/status only — never secret values. Degrades to a logged-out shape when
 * phantom is absent or not logged in. Producer must never throw.
 */
export interface Identity {
  /** Whether phantom reports an authenticated session. */
  loggedIn: boolean;
  /** Account id/handle, or null when logged out/unknown. */
  user: string | null;
  /** Tier/plan name, or null when logged out/unknown. */
  tier: string | null;
  /** Team name, or null when none/logged out/unknown. */
  team: string | null;
}

/**
 * Opt-in outward notification targets (M18). A webhook is a URL only — no
 * secret payloads. When unset, notify() is a strict no-op (never posts).
 */
export interface NotifyTarget {
  /** Slack incoming-webhook URL. Posts a concise completion summary when set. */
  slackWebhook?: string;
  /** Discord webhook URL. Posts a concise completion summary when set. */
  discordWebhook?: string;
  /**
   * M32: macOS desktop notification on new PENDING proposals (osascript;
   * metadata only — never the diff). OPT-IN: strict no-op unless true.
   */
  desktop?: boolean;
}

/**
 * M19: one GenAI span derived from a completed run/swarm task. METADATA ONLY —
 * carries token counts, cost, ids, status, and timing; NEVER prompts,
 * completions, tool args, file contents, or secrets. The single normalized
 * shape that both the OTLP emitter and the local-file sink consume.
 */
export interface GenAiSpan {
  /** Span name (e.g. the operation/task identifier — metadata, not content). */
  name: string;
  /** Owning run or swarm id this span belongs to. */
  runId: string;
  /** Model id used (maps to gen_ai.request.model). */
  model: string;
  /** Provider id used (maps to gen_ai.system). */
  provider: string;
  /** Routing tier (e.g. 'local' | 'cloud' or model-tier label). */
  tier: string;
  /** Prompt/input tokens (maps to gen_ai.usage.input_tokens). */
  tokensIn: number;
  /** Completion/output tokens (maps to gen_ai.usage.output_tokens). */
  tokensOut: number;
  /** Estimated USD cost for this span. */
  estCostUsd: number;
  /** Terminal status string (e.g. 'done' | 'failed' | 'aborted'). */
  status: string;
  /** ISO start timestamp. */
  startTs: string;
  /** ISO end timestamp. */
  endTs: string;
}

/**
 * M19: result of emitting spans through a TelemetrySink. Best-effort —
 * `ok:false` records a failure detail (logged to stderr only) and is NEVER
 * allowed to block or throw out of a run/swarm.
 */
export interface TelemetryEmitResult {
  /** Which sink handled the emit. */
  sink: "local" | "otlp";
  /** Whether the emit succeeded (best-effort; failures never block). */
  ok: boolean;
  /** Human-readable detail — NEVER contains the PAT, prompts, or content. */
  detail: string;
}

/**
 * M19: spend-governance verdict for the configured budget window. Advisory by
 * default ('warn'); 'over' may require --over-budget when cfg.telemetry
 * govAction is 'block'. Governance NEVER silently blocks a run.
 */
export interface GovernanceStatus {
  /** ok < 80% of cap, warn >= 80% of cap, over > cap. */
  level: "ok" | "warn" | "over";
  /** Spend (USD) over the window, from the forecast/rollup. */
  spentUsd: number;
  /** Configured spend cap (USD) for the window, or null when none is set. */
  capUsd: number | null;
  /** The budget window the verdict applies to (e.g. '7d'). */
  window: string;
  /** Human-readable summary — metadata only, never secrets. */
  message: string;
}

// ---------------------------------------------------------------------------
// M20: one-command onboarding + self-healing doctor/runtime
// ---------------------------------------------------------------------------

/**
 * M20: outcome of a single `doctor --fix` remediation attempt.
 *
 * One FixAction is produced per failing/warn DoctorCheck that `fixDoctor`
 * considers. SAFE + LOCAL + non-destructive only: create missing config from
 * defaults, rebuild a stale/missing index, create the ~/.local/bin symlink,
 * create the genome dir, register the ashlr MCP gateway (backup-first). NEVER
 * deletes/overwrites user data, NEVER auto-downloads models, NEVER touches
 * secrets. `applied` is whether the fix was performed; `manual` is true when
 * the check is fixable in principle but requires human action (left untouched).
 */
export interface FixAction {
  /** DoctorCheck.id this action corresponds to (e.g. 'config', 'index', 'local-bin', 'genome-memory', 'mcp-plugin'). */
  checkId: string;
  /** Human-readable label for what was (or would be) fixed. */
  label: string;
  /** Whether a safe automated remediation was actually performed. */
  applied: boolean;
  /** One-line detail: what was fixed, or why it was left for manual action. */
  detail: string;
  /** True when the check needs manual/human action and was deliberately not auto-fixed. */
  manual: boolean;
}

/**
 * M20: status of a single onboarding step produced by `onboard`.
 *
 *   'ok'       — already in the desired state / safe ensure succeeded.
 *   'wired'    — a mutating wire step completed (e.g. editor MCP registered).
 *   'detected' — something was detected + reported, no mutation performed.
 *   'skipped'  — step intentionally skipped (e.g. wire not requested).
 *   'manual'   — step needs human action (printed as guidance, never auto-done).
 */
export interface OnboardStep {
  /** Stable step name (e.g. 'config', 'models', 'editors', 'symlink', 'genome', 'phantom', 'doctor'). */
  name: string;
  /** Outcome of the step. */
  status: 'ok' | 'wired' | 'detected' | 'skipped' | 'manual';
  /** One-line human-readable detail — metadata only, never secrets. */
  detail: string;
}

/**
 * M20: full result of an idempotent, non-TTY-safe `ashlr init` onboarding run.
 */
export interface OnboardResult {
  /** All onboarding steps performed, in display order. */
  steps: OnboardStep[];
  /** True when the setup is complete enough to run (no blocking failures). */
  ready: boolean;
  /** Crisp next-step guidance lines (e.g. 'try: ashlr run / ashlr swarm / ashlr tui'). */
  nextSteps: string[];
}

/**
 * M20: bounds for self-healing runtime wrappers. ALL heal behavior is bounded
 * by these caps — there is never an unbounded restart/downgrade/backoff loop.
 */
export interface HealPolicy {
  /** Hard max number of heal-triggered retries (restart/downgrade/backoff). Bounded; never infinite. */
  maxRestarts: number;
  /** Whether OOM/model-error may downgrade to a SMALLER LOCAL model for a bounded retry. */
  allowDowngrade: boolean;
}

/**
 * M20: one self-heal event, surfaced to the caller's `onHeal` callback for
 * logging. Metadata only — never secrets.
 *
 *   'mcp-restart'     — a crashed MCP downstream was restarted (extends M3 skip-on-failure).
 *   'model-downgrade' — a local model OOM/error downgraded to a smaller local model.
 *   'rate-backoff'    — a cloud rate-limit triggered exponential backoff (only when allowCloud).
 */
export interface HealEvent {
  /** What kind of heal occurred. */
  kind: 'mcp-restart' | 'model-downgrade' | 'rate-backoff';
  /** One-line human-readable detail — metadata only, never secrets. */
  detail: string;
  /** 1-based attempt number that triggered this heal event. */
  attempt: number;
}

// ---------------------------------------------------------------------------
// M21: the SAFETY FOUNDATION for the v2 Autonomous Engineering Org. ALL future
// autonomous code work happens in an ISOLATED git-worktree sandbox, is recorded
// in an append-only audit trail, is gated by per-repo enrollment + a global kill
// switch, and is bounded/killable. These types are the primitives M22–M30 build
// on. None of them carry secret values.
// ---------------------------------------------------------------------------

/**
 * M21: one isolated git-worktree sandbox of a source repo. Created under
 * ~/.ashlr/sandboxes/<id>/ on a NEW scratch branch off the source repo's
 * current HEAD, so autonomous edits NEVER touch the user's working tree, index,
 * HEAD, or their checked-out branch. Bounded — created, used, then discarded
 * (git worktree remove + scratch-branch delete). METADATA ONLY.
 */
export interface Sandbox {
  /** Opaque sandbox id; also the directory name under ~/.ashlr/sandboxes/. */
  id: string;
  /** Absolute path to the source repo this sandbox was forked from. */
  sourceRepo: string;
  /** Absolute path to the isolated worktree (~/.ashlr/sandboxes/<id>/). */
  worktreePath: string;
  /** Name of the scratch branch created for this sandbox (deleted on cleanup). */
  branch: string;
  /** The source repo HEAD commit the scratch branch was forked from. */
  baseHead: string;
  /** ISO timestamp the sandbox was created. */
  createdAt: string;
  /**
   * H5 — pid of the process that created this sandbox (a POSITIVE liveness
   * marker). The orphan sweep / disk-cap pre-sweep SKIP a sandbox whose
   * `ownerPid` is still alive (process.kill(pid,0) succeeds) regardless of age,
   * so a LIVE in-flight worktree is NEVER force-removed out from under a running
   * swarm — even a long-running cross-process one older than ORPHAN_STALE_MS.
   * Optional for back-compat: older metadata (and crash-simulation fixtures that
   * model a GONE owner) omit it, in which case the conservative createdAt-age
   * staleMs guard governs reclaim instead.
   */
  ownerPid?: number;
}

/**
 * M21: the captured result of work done inside a sandbox — the git diff of the
 * worktree vs. its base. This is what an autonomous run PROPOSES; proposal-only
 * is the default posture (nothing is applied to the source repo). METADATA +
 * patch text only.
 */
export interface SandboxDiff {
  /** Id of the sandbox this diff was captured from. */
  sandboxId: string;
  /** Number of files changed. */
  files: number;
  /** Total inserted lines across the diff. */
  insertions: number;
  /** Total deleted lines across the diff. */
  deletions: number;
  /** The unified diff patch text (git diff output). */
  patch: string;
}

/**
 * M21: one append-only audit record of an autonomous/sandbox action. Written to
 * ~/.ashlr/audit/<date>.jsonl — never deleted, never holds secrets. Read back
 * via `ashlr audit`.
 */
export interface AuditEntry {
  /** ISO timestamp the action occurred (set by `audit()`, not the caller). */
  ts: string;
  /** Short action verb, e.g. 'sandbox.create', 'enroll.add', 'kill.set'. */
  action: string;
  /** Absolute source repo path the action concerned, or null if not repo-scoped. */
  repo: string | null;
  /** Sandbox id the action concerned, or null if not sandbox-scoped. */
  sandboxId: string | null;
  /** One-line human-readable summary — metadata only, never secrets. */
  summary: string;
  /** Outcome of the action. */
  result: 'ok' | 'refused' | 'error';
}

/**
 * M21: the enrollment registry — which repos are ENROLLED for autonomous work.
 * DEFAULT EMPTY: nothing enrolled => nothing autonomous can mutate any real
 * repo. Persisted in cfg.autonomy / ~/.ashlr/enrollment.json.
 */
export interface Enrollment {
  /** Absolute paths of repos enrolled for autonomous/sandbox mutation. */
  repos: string[];
}

/**
 * M22: WORK DISCOVERY — `ashlr backlog`.
 * A scored, prioritized work queue derived READ-ONLY across ENROLLED repos.
 */

/** The kind of source a WorkItem was derived from. */
export type WorkSource = 'issue' | 'todo' | 'test' | 'dep' | 'doc' | 'security' | 'plugin' | 'self'; // M33: 'plugin'; M54: 'self' (the fleet's own backlog) — both additive

/**
 * A single discovered, scored unit of work. Produced by a scanner over a
 * single enrolled repo. Contains NO secrets. Pure analysis — never implies a
 * mutation was performed.
 */
export interface WorkItem {
  /** Stable, deterministic id (e.g. `${repo}:${source}:${hash}`). */
  id: string;
  /** Absolute path of the enrolled repo this item belongs to. */
  repo: string;
  /** Which scanner produced this item. */
  source: WorkSource;
  /** Short, human-readable title. */
  title: string;
  /** Longer detail / context (no secrets). */
  detail: string;
  /** Estimated value of doing the work, 1 (low) .. 5 (high). */
  value: number;
  /** Estimated effort to do the work, 1 (low) .. 5 (high). */
  effort: number;
  /** Priority score; higher = do first. score = scoreItem(value, effort). */
  score: number;
  /** Free-form tags (e.g. ['security','npm-audit']). */
  tags: string[];
  /** ISO timestamp this item was generated. */
  ts: string;
}

/**
 * The aggregated, persisted backlog. Written to ~/.ashlr/backlog.json by
 * buildBacklog(). Covers only ENROLLED repos (DEFAULT EMPTY => empty items).
 */
export interface Backlog {
  /** ISO timestamp the backlog was generated. */
  generatedAt: string;
  /** Absolute paths of the repos that were scanned. */
  repos: string[];
  /** All discovered work items, deduped and scored. */
  items: WorkItem[];
}

/**
 * M23: what kind of outward action a Proposal represents.
 *   'patch'  — a unified diff to be applied on a NEW branch in the target repo.
 *   'pr'     — a branch+commit then a gated `gh pr create` (the M18 createPr).
 *   'deploy' — the gated ship/deploy path.
 *   'note'   — a no-op record (decision/observation only; never mutates).
 */
export type ProposalKind = 'patch' | 'pr' | 'deploy' | 'note';

/**
 * M23: lifecycle of a Proposal through the approval inbox gate.
 *   'pending'  — created, awaiting Mason's explicit decision (NEVER auto-applies).
 *   'approved' — Mason approved; eligible for applyProposal (still confirm-gated).
 *   'rejected' — Mason rejected; discarded, never applied.
 *   'applied'  — the approved outward action was performed successfully.
 *   'failed'   — apply was attempted (approved+confirmed) but errored.
 */
export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'applied' | 'failed';

/**
 * M23: a single PROPOSED outward action awaiting Mason's approval. The inbox is
 * the SINGLE human control plane through which EVERY outward mutation (PR, merge,
 * deploy, patch-applied-to-a-real-branch) must pass. The autonomous org (M24+)
 * creates these; nothing outward happens until Mason explicitly approves.
 * Persisted at ~/.ashlr/inbox/<id>.json. METADATA + diff/patch text only —
 * NEVER carries secret values.
 */
export interface Proposal {
  /** Stable unique id; also the inbox filename stem (~/.ashlr/inbox/<id>.json). */
  id: string;
  /** Absolute path of the target repo, or null when not repo-scoped (e.g. note). */
  repo: string | null;
  /**
   * Where the proposal came from: the backlog, an autonomous swarm, manual
   * creation, or an agent session via the native MCP tool `ashlr_inbox_propose`
   * (M31). Agent-originated proposals are created 'pending' like every other —
   * the origin tag exists so the inbox can display provenance.
   */
  origin: 'backlog' | 'swarm' | 'manual' | 'agent';
  /** What kind of outward action this represents. */
  kind: ProposalKind;
  /** Short human-readable title for inbox lists. */
  title: string;
  /** Longer human-readable summary of what + why. */
  summary: string;
  /** Optional unified diff (from a sandbox) — the patch a 'patch'/'pr' applies. */
  diff?: string;
  /** Optional id of the sandbox the diff was captured from (M21). */
  sandboxId?: string;
  /**
   * M45: provenance — backend + model that produced this proposal's diff
   * (e.g. 'codex:gpt-5.5'). A later merge-authority gate requires
   * engineTier === 'frontier' before any auto-apply to main.
   */
  engineModel?: string;
  engineTier?: EngineTier;
  /** M47.1: sha256 of the (scrubbed) diff at signing time. */
  diffHash?: string;
  /**
   * M47.1: HMAC over `${engineModel}|${engineTier}|${diffHash}` with the
   * per-machine provenance key — proves the trust tags were set by the
   * sandboxed producer (not forged on disk) and are bound to THIS diff.
   */
  provenanceSig?: string;
  /** Current lifecycle status. Created as 'pending'; NEVER auto-advances. */
  status: ProposalStatus;
  /** ISO timestamp the proposal was created. */
  createdAt: string;
  /** ISO timestamp Mason approved/rejected (set on the decision). */
  decidedAt?: string;
  /** Outcome detail recorded by applyProposal (branch name, PR url, error). */
  result?: string;
}

/**
 * M23: outcome of applyProposal — the ONLY outward path. Never thrown; failure
 * is reported here with status 'failed' and a detail. METADATA ONLY — no secrets.
 */
export interface ApplyResult {
  /** True only when the outward action completed successfully. */
  ok: boolean;
  /** The resulting proposal status: 'applied' on success, 'failed' otherwise. */
  status: ProposalStatus;
  /** Human-readable detail (branch created, PR url, refusal reason, error). */
  detail: string;
}

// ---------------------------------------------------------------------------
// M24: THE DAEMON — the autonomous operator.
//
// SAFE BY CONSTRUCTION. The daemon's ONLY output is PENDING proposals in the
// M23 approval inbox. It NEVER applies/approves a proposal, NEVER pushes, NEVER
// opens a PR, NEVER deploys, NEVER mutates a user repo working tree. It operates
// ONLY on listEnrolled() repos (DEFAULT EMPTY => it does nothing), all work runs
// SANDBOXED (M21 worktrees), and it is BOUNDED by a hard daily budget cap + a
// per-tick item cap + a concurrency cap, halted instantly by the kill switch.
// These types carry METADATA ONLY — never secret values.
// ---------------------------------------------------------------------------

/**
 * M24: bounding configuration for the autonomous operator. Every field caps HOW
 * MUCH the daemon may propose — none of them grant any outward authority (the
 * daemon is proposal-only by construction). Sourced from cfg.daemon (partial),
 * merged over conservative hard-coded defaults.
 */
export interface DaemonConfig {
  /** HARD daily spend ceiling (USD). When today's spend reaches it, the daemon
   *  idles/stops. Resets per calendar day. Default modest. */
  dailyBudgetUsd: number;
  /** Max number of backlog items processed per tick (per-tick item cap). */
  perTickItems: number;
  /** Bounded concurrency: max sandboxed swarms run simultaneously in a tick. */
  parallel: number;
  /** Interval between ticks in `daemon start` loop mode (ms). */
  intervalMs: number;
}

/**
 * M24: the record of a single operator cycle (one `tick`). Pure accounting of
 * what was considered + proposed + spent. Creating a tick NEVER applies anything.
 */
export interface DaemonTick {
  /** ISO timestamp the tick ran. */
  ts: string;
  /** How many backlog items were considered (post budget/cap selection). */
  itemsConsidered: number;
  /** How many PENDING proposals this tick created in the inbox. */
  proposalsCreated: number;
  /** Estimated USD spent during this tick. */
  spentUsd: number;
  /** Why the tick did what it did (e.g. 'ok', 'kill-switch', 'budget-exhausted',
   *  'no-enrolled-repos', 'no-backlog', 'dry-run'). */
  reason: string;
  /** M48: per-backend dispatch counts this tick (e.g. {builtin:2, claude:1}). */
  backends?: Record<string, number>;
  /** M48: proposals auto-merged this tick via the M47 gate (omitted/0 when disabled). */
  merged?: number;
}

/**
 * M24: persisted daemon state at ~/.ashlr/daemon.json. Tracks run/loop status,
 * today's spend (reset per day), cumulative items processed, and recent ticks.
 * METADATA ONLY — no secrets, no diffs. Mutating this NEVER mutates a user repo.
 */
export interface DaemonState {
  /** Whether the daemon loop is currently running. */
  running: boolean;
  /** OS pid of the running daemon process, or null when not running. */
  pid: number | null;
  /** ISO timestamp the current/last run started, or null. */
  startedAt: string | null;
  /** ISO timestamp of the most recent tick, or null. */
  lastTickAt: string | null;
  /** Calendar day (YYYY-MM-DD) the spend counters apply to; null until first tick. */
  todayDate: string | null;
  /** Estimated USD spent so far today; reset when todayDate rolls over. */
  todaySpentUsd: number;
  /** Cumulative count of backlog items processed across all ticks. */
  itemsProcessed: number;
  /** Bounded history of recent ticks (most-recent last). */
  ticks: DaemonTick[];
  /**
   * M91: ISO timestamp of the last SUCCESSFUL fleet→pulse export.
   * Used as sinceTs watermark so each tick only re-sends new events.
   * Absent until the first successful POST. Never set on failure.
   */
  lastPulseExportAt?: string;
}


/**
 * M25 (Portfolio Intelligence): a single chunk of source extracted from an
 * ENROLLED repo during a read-only knowledge walk. Persisted as JSONL under
 * `~/.ashlr/knowledge/<repo-hash>/*.jsonl`. Secrets are scrubbed BEFORE a chunk
 * is created/embedded; no chunk ever contains .env contents or secret-shaped
 * tokens. `vector` is present only when local Ollama embeddings succeeded;
 * otherwise retrieval falls back to keyword/TF-IDF scoring over `text`.
 */
export interface KnowledgeChunk {
  /** Absolute path of the enrolled repo this chunk came from. */
  repo: string;
  /** Repo-relative path of the source file. */
  file: string;
  /** 1-based first line of the chunk span within the file. */
  startLine: number;
  /** 1-based last line of the chunk span within the file (inclusive). */
  endLine: number;
  /** Scrubbed source text of the chunk (no secrets). */
  text: string;
  /** Local embedding vector, present only when Ollama embeddings succeeded. */
  vector?: number[];
  /** Optional short local-model summary of the chunk. */
  summary?: string;
}

/**
 * M25: one retrieved chunk plus its relevance score for an `ashlr ask` query.
 * Score is cosine similarity (embedding path) or normalized keyword/TF-IDF
 * score (fallback path); higher is more relevant.
 */
export interface AskHit {
  /** The retrieved knowledge chunk. */
  chunk: KnowledgeChunk;
  /** Relevance score (embedding cosine or keyword score); higher = better. */
  score: number;
}

/**
 * M25: result of `ashlr ask "<question>"` — a LOCAL RAG answer synthesized from
 * retrieved portfolio chunks with explicit source citations. `local` MUST be
 * true unless --allow-cloud was explicitly passed AND a key exists; the default
 * path keeps all private code on the machine.
 */
export interface AskResult {
  /** The original question text. */
  question: string;
  /** Synthesized natural-language answer. */
  answer: string;
  /** Cited sources backing the answer (repo / file:line). */
  sources: { repo: string; file: string; line: number }[];
  /** Retrieval method used: local embeddings or keyword/TF-IDF fallback. */
  method: "embedding" | "keyword";
  /** True when synthesis ran entirely on the LOCAL model (no code sent to cloud). */
  local: boolean;
}

/**
 * M25: result of `ashlr impact <file|symbol>` — where a target is referenced
 * and what depends on it, within and across ENROLLED repos. Pure read-only
 * analysis; never mutates a repo.
 */
export interface ImpactResult {
  /** The file path or symbol that was analyzed. */
  target: string;
  /** Locations that reference the target (repo / file:line). */
  references: { repo: string; file: string; line: number }[];
  /** Identifiers (repo/module/dep node ids) that depend on the target. */
  dependents: string[];
}

/**
 * M25: a lightweight cross-portfolio knowledge graph over ENROLLED repos.
 * Nodes are repos/modules/key deps; edges capture imports/depends/shared-dep
 * relationships. `crossRepo` surfaces signals spanning repos (e.g. the same
 * outdated/vulnerable dependency, or a duplicated pattern). Built read-only.
 */
export interface KnowledgeGraph {
  /** Graph nodes: repos, modules, and key dependencies. */
  nodes: { id: string; kind: string; label: string }[];
  /** Directed edges between nodes (imports / depends / shared-dep). */
  edges: { from: string; to: string; kind: string }[];
  /** Cross-repo findings (shared/duplicated deps or patterns) and the repos involved. */
  crossRepo: { kind: string; detail: string; repos: string[] }[];
}


// ---------------------------------------------------------------------------
// M26: SELF-IMPROVEMENT / META-LEARNING — `ashlr reflect`
//
// The reflection loop scores the org's OWN past swarms/runs/usage, distills
// playbooks, and proposes routing/policy/prompt tuning. SAFE BY CONSTRUCTION:
//   - READ-ONLY over history (swarms, genome, usage). Writes ONLY under
//     ~/.ashlr/learn/ (reports, snapshots) and — only on `reflect propose` —
//     to the M23 Approval Inbox via createProposal() (status pending).
//   - NEVER mutates config.json / router policy / prompts / any user repo.
//   - The METRICS engine is DETERMINISTIC and computed WITHOUT any LLM. Only
//     optional narrative/playbook TEXT may route through getActiveClient
//     (local-only unless --allow-cloud + a key), mirroring M25 ask.ts.
//   - BOUNDED: reads at most `maxRuns` recent swarms / a `--since` window.
// These types carry METADATA ONLY — never secret values, never raw payloads.
// ---------------------------------------------------------------------------

/**
 * M26: one clustered failure mode distilled from failed/aborted swarms and
 * failed tasks. Built deterministically by clustering normalized task.error
 * strings / failed phase names. No LLM. METADATA ONLY.
 */
export interface FailureMode {
  /** Stable cluster key (normalized error signature or phase name). */
  key: string;
  /** Human-readable label for the cluster. */
  label: string;
  /** Number of failed tasks/swarms that fell into this cluster. */
  count: number;
  /** Which swarm phase(s) this failure most often occurred in. */
  phases: string[];
  /** A few representative swarm ids exhibiting this failure (bounded sample). */
  exampleSwarmIds: string[];
}

/**
 * M26: per-goal-category aggregation — the slowest / most-expensive kinds of
 * work, derived deterministically by bucketing swarm goals into coarse
 * categories (keyword heuristic). No LLM. METADATA ONLY.
 */
export interface GoalCategoryStat {
  /** Coarse category label (e.g. 'refactor', 'feature', 'bugfix', 'docs', 'other'). */
  category: string;
  /** Number of swarms in this category within the window. */
  swarms: number;
  /** Mean estimated USD cost per swarm in this category. */
  avgCostUsd: number;
  /** Mean total tokens (in+out) per swarm in this category. */
  avgTokens: number;
  /** Success rate (done / total) for this category, 0..1. */
  successRate: number;
}

/**
 * M26: week-over-week (snapshot-over-snapshot) deltas vs the previous persisted
 * ReflectionReport. All deltas are computed deterministically by diffing the
 * current metrics against the prior snapshot loaded from
 * ~/.ashlr/learn/reports/. Absent fields => no prior snapshot to compare.
 */
export interface ReflectionDelta {
  /** ISO timestamp of the prior snapshot this delta compares against, or null. */
  previousAt: string | null;
  /**
   * Change in effectiveness, expressed as a signed percentage-point delta of
   * success rate (e.g. +12 means "12 points more effective"). null when no prior.
   */
  effectivenessPct: number | null;
  /**
   * Change in average cost per swarm, expressed as a signed percentage
   * (e.g. -18 means "18% cheaper"). null when no prior.
   */
  costPct: number | null;
  /** Signed percentage-point change in local-vs-cloud share. null when no prior. */
  localSharePct: number | null;
  /** One-line human summary of the headline movements (deterministic template). */
  headline: string;
}

/**
 * M26: the deterministic reflection report. Persisted as a snapshot under
 * ~/.ashlr/learn/reports/<ts>.json and used as the prior for the next run's
 * week-over-week deltas. Computed entirely WITHOUT an LLM (an optional
 * narrative field may be added later by playbooks.ts, but is never required).
 * METADATA ONLY — never carries secret values or raw code/payloads.
 */
export interface ReflectionReport {
  /** ISO timestamp the report was generated. */
  generatedAt: string;
  /** ISO lower bound of the analysis window (inclusive). */
  since: string;
  /** Window label when derived from --since (e.g. '7d'/'30d'), else null. */
  window: string | null;
  /** How many swarms were actually read (bounded by maxRuns/since). */
  swarmsAnalyzed: number;
  /** Count of swarms with status 'done'. */
  swarmsDone: number;
  /** Count of swarms with status 'failed' or 'aborted'. */
  swarmsFailed: number;
  /** Success rate: swarmsDone / swarmsAnalyzed (0..1; 0 when none). */
  successRate: number;
  /** Mean estimated USD cost per analyzed swarm. */
  avgCostUsd: number;
  /** Mean total tokens (in+out) per analyzed swarm. */
  avgTokens: number;
  /** Total estimated USD cost across analyzed swarms. */
  totalCostUsd: number;
  /** Share of token usage served by LOCAL providers (0..1) from usage events. */
  localShare: number;
  /** Top clustered failure modes, most frequent first (bounded). */
  topFailures: FailureMode[];
  /** Slowest / most-expensive goal categories, most-expensive first (bounded). */
  goalCategories: GoalCategoryStat[];
  /** Week-over-week deltas vs the prior snapshot (templated, deterministic). */
  delta: ReflectionDelta;
  /** Genome health snapshot at report time (entry counts etc.). */
  genome: GenomeHealth;
  /**
   * Optional LLM-assisted narrative summary. ABSENT on the default path
   * (deterministic-only). Populated ONLY when narrative generation is requested
   * and a provider is reachable (local unless --allow-cloud + key). When set,
   * `narrativeLocal` records whether it was produced by a local model.
   */
  narrative?: string;
  /** True when `narrative` was produced by a LOCAL model; absent when no narrative. */
  narrativeLocal?: boolean;
}

/**
 * M26: a single PROPOSAL-ONLY tuning suggestion derived from a ReflectionReport.
 * These NEVER auto-apply: emitTuningProposals() routes each one to the M23
 * Approval Inbox as a PENDING proposal (kind 'note' — a no-op record that
 * mutates nothing), or the report prints them. There is NO code path that writes
 * config.json / router policy / prompts. METADATA ONLY.
 */
export interface TuningProposal {
  /** Stable suggestion key (e.g. 'routing.local-first-threshold'). */
  key: string;
  /** What aspect this suggestion concerns (purely descriptive; never applied). */
  area: 'routing' | 'policy' | 'prompt' | 'playbook';
  /** Short human-readable title for the inbox / report. */
  title: string;
  /** Longer rationale grounded in the report's deterministic metrics. */
  rationale: string;
  /** Confidence in the suggestion (0..1), derived from sample size / effect. */
  confidence: number;
}

/** Options accepted by `buildReflection` (the deterministic metrics engine). */
export interface ReflectionOptions {
  /** Analyze only swarms created at/after this epoch-ms lower bound. */
  sinceMs?: number;
  /** Hard cap on how many recent swarms to read (bounds I/O). */
  maxRuns?: number;
  /** Window label to record on the report (purely informational). */
  window?: string | null;
}

// ---------------------------------------------------------------------------
// M27: QUALITY & STANDARDS ENFORCEMENT — `ashlr health`.
//
// SAFE BY CONSTRUCTION. `ashlr health` is a READ-ONLY, continuous portfolio
// quality review. It READS enrolled repos (via the M22 read-only scanners +
// lightweight FS convention probes) and WRITES only under ~/.ashlr/quality/
// (score snapshots) and — only on an explicit `propose` action — PENDING M23
// Approval Inbox proposals. It NEVER mutates a user repo working tree, NEVER
// pushes/opens-PRs/deploys, operates ONLY over listEnrolled() repos (DEFAULT
// EMPTY => reports nothing, no disk scan), and uses NO LLM by default. These
// types carry METADATA ONLY — never secret values.
// ---------------------------------------------------------------------------

/**
 * M27: the quality dimensions a HealthScore is decomposed into. Each maps
 * naturally onto one M22 scanner (tests/docs/deps/security/code-debt/issues-CI)
 * plus a `conventions` dimension fed by the read-only convention probes.
 */
export type HealthDimension =
  | 'tests'        // scanTests: test-script presence + CI state
  | 'docs'         // scanDocs: README/LICENSE/CONTRIBUTING presence + thinness
  | 'deps'         // scanDeps: dependency freshness + npm-audit vulnerabilities
  | 'security'     // scanSecurity: security findings (binshield)
  | 'codeDebt'     // scanTodos: TODO/FIXME/HACK/XXX code-debt markers
  | 'issuesCi'     // scanIssues: open GitHub issues + CI signal
  | 'conventions'; // conventions.ts: project-standards probes (lockfile, .gitignore, CI config, …)

/** A letter grade derived deterministically from a 0..100 score. */
export type HealthGrade = 'A' | 'B' | 'C' | 'D' | 'F';

/**
 * M27: a single read-only project-standards probe result for one repo.
 * Produced by conventions.ts via pure FS reads (presence/size checks). Carries
 * NO secrets and NEVER implies a mutation was performed.
 */
export interface ConventionFinding {
  /** Stable probe key, e.g. 'license' | 'gitignore' | 'lockfile' | 'ci' | 'readme' | 'testdir'. */
  key: string;
  /** Short human-readable label for the probe (e.g. 'LICENSE file'). */
  label: string;
  /** True when the convention is satisfied (e.g. the file/dir/script exists). */
  ok: boolean;
  /** Severity weight of a MISS (1 low .. 5 high); ignored when ok=true. */
  weight: number;
  /** Longer detail / remediation hint (no secrets). */
  detail: string;
}

/**
 * M27: the per-dimension contribution to a repo's HealthScore. Deterministic.
 */
export interface HealthDimensionScore {
  /** Which dimension this entry scores. */
  dimension: HealthDimension;
  /** Normalized dimension score, 0 (worst) .. 100 (best). */
  score: number;
  /** Relative weight of this dimension in the overall 0..100 roll-up. */
  weight: number;
  /** Count of underlying findings (WorkItems / failed convention probes) feeding it. */
  findingCount: number;
  /** Short, deterministic human-readable summary line (no secrets). */
  summary: string;
}

/**
 * M27: the per-repo HEALTH SCORE. Produced by computeHealth(repo) from the six
 * M22 scanners + conventions probes. Deterministic, READ-ONLY, NO LLM.
 * METADATA ONLY — never carries secret values.
 */
export interface HealthScore {
  /** Absolute path of the enrolled repo this score belongs to. */
  repo: string;
  /** Weighted overall score, 0 (worst) .. 100 (best). */
  score: number;
  /** Letter grade derived from `score` (A>=90, B>=80, C>=70, D>=60, else F). */
  grade: HealthGrade;
  /** Per-dimension breakdown (one entry per HealthDimension). */
  dimensions: HealthDimensionScore[];
  /** Convention probe results for this repo (read-only FS probes). */
  conventions: ConventionFinding[];
  /**
   * The worst offenders — the highest-priority WorkItems (by WorkItem.score)
   * dragging this repo's grade down, bounded to a small cap. METADATA ONLY.
   */
  worstOffenders: WorkItem[];
  /** ISO timestamp this score was computed. */
  ts: string;
}

/**
 * M27: the portfolio-wide HEALTH REPORT. Produced by computeReport({ repos? })
 * over enrolled repos (default listEnrolled(); explicit repos filtered through
 * isEnrolled()). Persisted under ~/.ashlr/quality/ for trend tracking.
 * METADATA ONLY — never carries secret values.
 */
export interface HealthReport {
  /** ISO timestamp the report was generated. */
  generatedAt: string;
  /** Absolute paths of the enrolled repos that were scored. */
  repos: string[];
  /** Per-repo scores, ranked worst-first (lowest score first) by default. */
  scores: HealthScore[];
  /** Mean overall score across all scored repos (0..100), or 0 when empty. */
  averageScore: number;
  /** Letter grade derived from `averageScore`. */
  averageGrade: HealthGrade;
  /**
   * Per-repo overall-score delta vs the previous persisted report
   * (loadPreviousReport), keyed by absolute repo path. Positive = improved.
   * Absent entries have no prior snapshot to compare against.
   */
  delta: Record<string, number>;
  /**
   * Optional LLM-assisted narrative summary. ABSENT on the default path
   * (deterministic-only). Populated ONLY when narrative generation is requested
   * and a provider is reachable (local unless --allow-cloud + key). When set,
   * `narrativeLocal` records whether it was produced by a local model.
   */
  narrative?: string;
  /** True when `narrative` was produced by a LOCAL model; absent when no narrative. */
  narrativeLocal?: boolean;
}

/**
 * M27: a single deterministic, advisory SAFE FIX derived from a HealthScore's
 * findings (e.g. "add a LICENSE", "add .gitignore", "pin/upgrade vulnerable dep
 * X", "add a test for Y"). emitFixProposals() routes each to the M23 Approval
 * Inbox as a PENDING proposal (kind 'note' by default — a no-op advisory record
 * that mutates nothing; origin 'manual'). M27 NEVER auto-applies a fix and NEVER
 * mutates a repo. METADATA ONLY.
 */
export interface SafeFix {
  /** Absolute path of the repo this fix targets. */
  repo: string;
  /** The dimension this fix improves. */
  dimension: HealthDimension;
  /** Stable fix key (e.g. 'docs.add-license', 'conventions.add-gitignore'). */
  key: string;
  /** Short human-readable title for the inbox / report. */
  title: string;
  /** Longer rationale grounded in the repo's deterministic findings (no secrets). */
  rationale: string;
  /**
   * Whether this fix is purely advisory ('note') or could carry a deterministic
   * sandbox-generated diff ('patch'). Default 'note'; 'patch' is a documented
   * STRETCH only — any diff MUST be produced in an M21 sandbox worktree and
   * attached as a PENDING proposal, NEVER written to the real tree.
   */
  proposalKind: Extract<ProposalKind, 'note' | 'patch'>;
}

/** Options accepted by `computeReport` (the deterministic health engine). */
export interface HealthOptions {
  /**
   * Explicit repo list. When provided, EACH entry MUST be filtered through
   * isEnrolled() (resolve() first) — non-enrolled paths HARD-ERROR. When
   * omitted, defaults to listEnrolled() (DEFAULT EMPTY => empty report).
   */
  repos?: string[];
  /** Hard cap on how many repos to score in one run (bounds work). */
  maxRepos?: number;
}

// ---------------------------------------------------------------------------
// M28: GOAL PLANNING & SCHEDULING — `ashlr goals` (Ashlr v2 pillar F).
//
// SAFE BY CONSTRUCTION. M28 is the PLANNING + TRACKING + SCHEDULING layer on
// top of the already-safe execution path. It introduces NO new outward
// authority. A high-level OBJECTIVE (Goal) is decomposed into ordered
// MILESTONES; each milestone authors/links a versioned SpecArtifact and is
// advanced via the EXACT M21/M24 pattern — runSwarm with
// { sandbox:true, requireSandbox:true, propose:true } + a hard budget, gated
// by assertMayMutate(repo). A goal can NEVER mutate a real working tree, push,
// open a PR, or deploy — its ONLY execution sink is a PENDING inbox proposal a
// human approves later. Planning/tracking writes ONLY under ~/.ashlr/goals/.
// These types carry METADATA ONLY — never secret values.
// ---------------------------------------------------------------------------

/**
 * Lifecycle status of a single Milestone.
 *  - 'pending'     : not yet advanced; eligible to be the next actionable one.
 *  - 'in-progress' : a sandboxed, proposal-only swarm is currently running.
 *  - 'proposed'    : the swarm produced a PENDING inbox proposal (linked via
 *                    proposalId). This is the terminal "success" state M28
 *                    drives to — a human approves the proposal out-of-band.
 *  - 'paused'      : the human paused this milestone; it is skipped by
 *                    nextActionableMilestone() until resumed.
 *  - 'skipped'     : the human skipped this milestone permanently.
 *  - 'blocked'     : an advance attempt failed/escalated (swarm 'failed' /
 *                    'aborted' / 'needs-approval'); requires human attention.
 *  - 'done'        : the milestone's proposal was approved+applied out-of-band
 *                    (set by a read-only reconcile against inbox state, never
 *                    by M28 mutating the proposal itself).
 */
export type MilestoneStatus =
  | 'pending'
  | 'in-progress'
  | 'proposed'
  | 'paused'
  | 'skipped'
  | 'blocked'
  | 'done';

/**
 * Lifecycle status of a whole Goal (objective). Derived/rolled-up from its
 * milestones by progressOf(), but persisted for cheap listing.
 *  - 'planning'  : created; milestones not yet decomposed (no plan yet).
 *  - 'active'    : has milestones; at least one is pending/in-progress.
 *  - 'paused'    : the human paused the entire goal (no milestone advances).
 *  - 'done'      : every non-skipped milestone is 'done'.
 *  - 'archived'  : the human retired the goal (read-only henceforth).
 */
export type GoalStatus = 'planning' | 'active' | 'paused' | 'done' | 'archived';

/**
 * M28: a single MILESTONE within a Goal. Each milestone is an ordered unit of
 * work that authors/links a versioned SpecArtifact and is advanced by a single
 * sandboxed, proposal-only swarm. Milestones are TRACKED over time and the
 * human STEERS them (reorder/pause/skip). METADATA ONLY — no secrets.
 */
export interface Milestone {
  /** Stable, deterministic milestone id (unique within its Goal). */
  id: string;
  /** Short human-readable title (the decomposed sub-objective). */
  title: string;
  /** Longer detail / acceptance hint for this milestone (no secrets). */
  detail: string;
  /** Explicit ordering key; lower = earlier. Reorder mutates these. */
  order: number;
  /** Current lifecycle status. Created as 'pending'. */
  status: MilestoneStatus;
  /**
   * Id of the versioned SpecArtifact this milestone authors/links (via
   * authorSpec), or null until `goals plan` has run. NEVER an outward action.
   */
  specId: string | null;
  /**
   * Id of the SwarmRun produced by the most recent advance of this milestone,
   * or null if never advanced. READ-ONLY tracking handle (loadSwarm(swarmId)).
   */
  swarmId: string | null;
  /**
   * Id of the PENDING inbox Proposal the swarm emitted (its ONLY execution
   * sink), or null. READ-ONLY tracking handle (loadProposal(proposalId)). M28
   * NEVER approves/applies this proposal.
   */
  proposalId: string | null;
  /** ISO timestamp the milestone was created. */
  createdAt: string;
  /** ISO timestamp the milestone was last updated. */
  updatedAt: string;
}

/**
 * M28: a high-level OBJECTIVE the org decomposes into ordered Milestones.
 * Persisted one-file-per-goal at ~/.ashlr/goals/<id>.json (atomic JSON, mirror
 * of the learn/quality stores). PLANNING + TRACKING data only — creating or
 * editing a Goal NEVER touches a user repo, never runs a swarm, and never
 * emits an outward action. METADATA ONLY — no secrets.
 */
export interface Goal {
  /** Stable unique id; also the file stem (~/.ashlr/goals/<id>.json). */
  id: string;
  /** The high-level objective text the goal was created from. */
  objective: string;
  /**
   * Absolute path of the ENROLLED repo this goal is bound to, or null when the
   * goal is repo-agnostic (planning-only; cannot be advanced). When set, it
   * MUST be filtered through isEnrolled() (resolve() first) at BOTH the core
   * advance path and the CLI before any swarm starts.
   */
  project: string | null;
  /** Rolled-up lifecycle status. Created as 'planning'. */
  status: GoalStatus;
  /** Ordered milestones (sorted by `order`). Empty until `goals plan` runs. */
  milestones: Milestone[];
  /** ISO timestamp the goal was created. */
  createdAt: string;
  /** ISO timestamp the goal was last updated. */
  updatedAt: string;
}

/**
 * M28: options for the deterministic-by-default decomposition of an objective
 * into Milestones (planner.decomposeGoal). LOCAL-FIRST: no model is used unless
 * `allowCloud` opens the local-first provider chain (Ollama/LM Studio only
 * unless a cloud key is configured). BOUNDED by `maxMilestones`.
 */
export interface DecomposeOptions {
  /**
   * Permit an optional LLM-assisted refinement of the deterministic split,
   * routed through getActiveClient(cfg, { allowCloud }). Default false =
   * deterministic, local-only, ZERO non-localhost connections.
   */
  allowCloud?: boolean;
  /** Hard cap on how many milestones to produce (bounds the plan). */
  maxMilestones?: number;
}

/**
 * M28: options for advancing a single milestone (advance.advanceGoal). The
 * advance ALWAYS runs runSwarm with { sandbox:true, requireSandbox:true,
 * propose:true } — these are NOT configurable here; only the bound/test-seam
 * knobs below are exposed.
 */
export interface AdvanceOptions {
  /**
   * Partial budget override merged over the M28 default HARD per-advance
   * ceiling. The advance NEVER runs unbounded.
   */
  budget?: Partial<RunBudget>;
  /**
   * Permit a CLOUD model inside the advanced swarm (default false =
   * local-first). Threaded into SwarmOptions.allowCloud only.
   */
  allowCloud?: boolean;
  /**
   * TEST SEAM only — forwarded to assertMayMutate(repo, { allowAnyRepo }) so
   * tests can advance a goal bound to a tmp repo without enrolling it. NEVER
   * bypasses the kill switch. Defaults to undefined (real enrollment enforced).
   *
   * HARDENED (M28 final fix): advanceGoal honors this ONLY when the process
   * ALSO sets the env var ASHLR_TEST_ALLOW_ANY_REPO=1. A production / in-process
   * caller passing { allowAnyRepo: true } WITHOUT that env var CANNOT bypass the
   * enrollment check — so enrollment-scoping (invariant #2) holds on every
   * shipped codepath. It also never reaches the runner, which re-enforces
   * enrollment at swarm start regardless.
   */
  allowAnyRepo?: boolean;
}

/**
 * M28: read-only roll-up of a Goal's progress (progressOf). Pure analysis over
 * the goal record + swarm/inbox state — mutates NOTHING. METADATA ONLY.
 */
export interface GoalProgress {
  /** The goal id this roll-up describes. */
  goalId: string;
  /** Total milestone count. */
  total: number;
  /** Count of milestones in each status (sparse — only non-zero keys present). */
  byStatus: Partial<Record<MilestoneStatus, number>>;
  /** Count of milestones that have produced a PENDING proposal ('proposed'). */
  proposed: number;
  /** Count of milestones fully 'done'. */
  done: number;
  /** Fraction complete (done / (total - skipped)), 0..1; 0 when nothing to do. */
  fractionDone: number;
  /**
   * The next actionable milestone id (the lowest-order 'pending' milestone when
   * the goal is not paused), or null when there is nothing to advance.
   */
  nextActionableId: string | null;
}

// ---------------------------------------------------------------------------
// M29: PORTFOLIO DASHBOARD + DIGEST — Ashlr v2 pillar G (surfacing).
//
// SAFE BY CONSTRUCTION. M29 is a READ-ONLY aggregation + a LOCAL daily digest.
// The portfolio snapshot and digest only READ already-local state (index, runs,
// swarms, health snapshots, goals, backlog, inbox, observability rollup/
// forecast, daemon state, genome). They WRITE only under ~/.ashlr/digests/
// (digest artifacts). They NEVER mutate a repo/working tree, NEVER write
// CONFIG_PATH, NEVER apply/approve a proposal, NEVER push/PR/deploy. The ONLY
// outward path is notify() behind an explicit, opt-in `--notify` flag. The v2
// portfolio dimensions (health, goals) are ENROLLMENT-SCOPED (default empty =>
// empty sections, NO portfolio disk scan). Aggregation + rendering is
// deterministic with NO LLM by default; an optional narrative routes through
// getActiveClient(cfg, { allowCloud }) (local-only unless --allow-cloud + key).
// Every source is wrapped so a missing/failed source degrades to a zeroed/empty
// section; list sizes are capped. These types carry METADATA ONLY — no secrets.
// ---------------------------------------------------------------------------

/**
 * M29: org-level HEALTH summary distilled from the M27 HealthReport over
 * ENROLLED repos. Empty (zeros + empty list) when nothing is enrolled or the
 * M27 source is unavailable. METADATA ONLY.
 */
export interface PortfolioHealthSummary {
  /** Number of enrolled repos that were scored (0 when none enrolled). */
  reposScored: number;
  /** Portfolio mean overall score, 0..100 (0 when none). */
  averageScore: number;
  /** Letter grade derived from `averageScore`. */
  averageGrade: HealthGrade;
  /**
   * The worst-scoring repos (lowest score first), bounded to a small cap. Each
   * entry is a compact handle — repo path label, score, grade. METADATA ONLY.
   */
  worstRepos: { repo: string; score: number; grade: HealthGrade }[];
}

/**
 * M29: a single IN-FLIGHT goal surfaced in the portfolio. Derived from the M28
 * Goal record + progressOf() — pure read-only roll-up; references the next
 * actionable milestone by title (read-only handle). METADATA ONLY.
 */
export interface PortfolioGoalInFlight {
  /** The goal id (read-only handle into the M28 goals store). */
  goalId: string;
  /** The high-level objective text. */
  objective: string;
  /** Rolled-up goal lifecycle status. */
  status: GoalStatus;
  /** Fraction of milestones complete, 0..1. */
  fractionDone: number;
  /** Count of milestones that produced a PENDING proposal. */
  proposed: number;
  /** Total milestone count. */
  totalMilestones: number;
  /**
   * Title of the next actionable milestone (lowest-order 'pending'), or null
   * when there is nothing to advance. Read-only display handle.
   */
  nextActionable: string | null;
}

/**
 * M29: a single top BACKLOG item surfaced in the portfolio. Compact projection
 * of an M22 WorkItem — title, repo label, and score. METADATA ONLY.
 */
export interface PortfolioBacklogItem {
  /** Short human-readable title of the work item. */
  title: string;
  /** Absolute path / label of the repo the item belongs to, or null. */
  repo: string | null;
  /** The item's priority score (higher = more important). */
  score: number;
}

/**
 * M29: the COST block of the portfolio — actual spend for the window (from the
 * M19 rollup) plus the M19 CostForecast (local savings + monthly projection).
 * All figures are ESTIMATES. Zeroed on failure. METADATA ONLY.
 */
export interface PortfolioCost {
  /** Window label the cost block is built from (e.g. '7d' | '30d'). */
  window: string;
  /** Actual USD spent in the window (local providers contribute $0). */
  spentUsd: number;
  /** Estimated USD the same local tokens WOULD have cost on cloud (savings). */
  localSavingsUsd: number;
  /** Simple projected monthly USD spend extrapolated from the window's rate. */
  projectedMonthlyUsd: number;
}

/**
 * M29: the EFFECTIVENESS headline — a one-line read-only projection of the most
 * recent M26 ReflectionReport + its week-over-week delta. Absent when there is
 * no reflect report. METADATA ONLY.
 */
export interface PortfolioEffectiveness {
  /** Success rate from the latest reflection report (0..1). */
  successRate: number;
  /** Signed effectiveness delta in percentage points vs prior, or null. */
  effectivenessDeltaPct: number | null;
  /** Deterministic one-line headline (templated by M26's computeDelta). */
  headline: string;
}

/**
 * M29: the "today" DELTA block — day-over-day movements computed against the
 * previous persisted digest (loadPreviousDigest). All deltas are signed and
 * null when there is no prior digest to compare against. Pure read-only
 * arithmetic — mutates NOTHING. METADATA ONLY.
 */
export interface PortfolioTodayDelta {
  /** ISO timestamp of the prior digest this block compares against, or null. */
  previousAt: string | null;
  /** Signed change in pending inbox proposals since the prior digest, or null. */
  pendingProposalsDelta: number | null;
  /** Signed change in dirty repos since the prior digest, or null. */
  dirtyReposDelta: number | null;
  /** Signed change in window spend (USD) since the prior digest, or null. */
  spendUsdDelta: number | null;
  /** Signed change in portfolio average health score since the prior, or null. */
  healthScoreDelta: number | null;
  /** Signed change in count of in-flight goals since the prior digest, or null. */
  goalsInFlightDelta: number | null;
}

/**
 * M29: the OPTIONAL org-level portfolio section embedded in DashboardSnapshot.
 * Each field is independently degradable — an empty enrollment / missing source
 * leaves that field at its empty/zeroed default with NO disk scan. READ-ONLY
 * aggregation only. METADATA ONLY — never carries secret values.
 */
export interface PortfolioSummary {
  /** Health roll-up over ENROLLED repos (M27). Empty when none enrolled. */
  health: PortfolioHealthSummary;
  /** In-flight goals (M28), bounded to a small cap, most-progressed first. */
  goalsInFlight: PortfolioGoalInFlight[];
  /** Top scored backlog work items (M22), bounded to a small cap. */
  backlogTop: PortfolioBacklogItem[];
  /** Cost + forecast for the dashboard window (M19). */
  cost: PortfolioCost;
  /** Effectiveness headline from the latest reflection report (M26), or null. */
  effectiveness: PortfolioEffectiveness | null;
  /** Day-over-day "today" deltas vs the previous digest (M29 store). */
  today: PortfolioTodayDelta;
}

/**
 * M29: window accepted by the digest + portfolio cost block. Mirrors the M19
 * forecast windows. Defaults to '7d'.
 */
export type DigestWindow = '7d' | '30d';

/**
 * M29: options for buildDigest. LOCAL-FIRST: no model is used unless
 * `allowCloud` opens the local-first provider chain (Ollama/LM Studio only
 * unless a cloud key is configured). `window` controls the cost block.
 */
export interface DigestOptions {
  /** Cost/forecast window. Default '7d'. */
  window?: DigestWindow;
  /**
   * OPT-IN: attempt an optional LLM-assisted narrative. Default false =
   * deterministic-only, NO model is ever constructed (mirrors the M26 reflect
   * `narrative` gate). Even a reachable LOCAL provider is NOT consulted unless
   * this is true — so the default `ashlr digest` path makes ZERO model calls.
   */
  narrative?: boolean;
  /**
   * When `narrative` is true, permit a CLOUD model for it (routed through
   * getActiveClient(cfg, { allowCloud })). Default false = local-only (Ollama/
   * LM Studio), ZERO non-localhost connections. Has NO effect unless
   * `narrative` is also true.
   */
  allowCloud?: boolean;
}

/**
 * M29: the deterministic DAILY DIGEST report. Built from a portfolio snapshot
 * (DashboardSnapshot incl. its `portfolio` section) plus day-over-day deltas vs
 * the previous persisted digest. Persisted as JSON + markdown under
 * ~/.ashlr/digests/ and used as the prior for the next day's deltas. Computed
 * entirely WITHOUT an LLM on the default path. METADATA ONLY — no secrets.
 */
export interface DigestReport {
  /** ISO timestamp the digest was generated. */
  generatedAt: string;
  /** Calendar day (YYYY-MM-DD) the digest summarizes. */
  date: string;
  /** Cost/forecast window the digest's cost figures use. */
  window: DigestWindow;
  /**
   * The portfolio section that backs this digest (snapshot of the org view at
   * generation time). Carries health/goals/backlog/cost/effectiveness/today.
   */
  portfolio: PortfolioSummary;
  /** Compact repo roll-up at generation time (from the base DashboardSnapshot). */
  repos: { total: number; dirty: number; stale: number };
  /** Pending inbox proposals awaiting approval at generation time (M23). */
  pendingProposals: number;
  /** Operator (daemon) status at generation time (M24), or null when absent. */
  daemon: { running: boolean; todaySpentUsd: number } | null;
  /**
   * Deterministic one-line human headline summarizing the day (templated; no
   * LLM). Always present.
   */
  headline: string;
  /**
   * Optional LLM-assisted narrative summary. ABSENT on the default path
   * (deterministic-only). Populated ONLY when narrative generation is requested
   * and a provider is reachable (local unless --allow-cloud + key). When set,
   * `narrativeLocal` records whether it was produced by a local model.
   */
  narrative?: string;
  /** True when `narrative` was produced by a LOCAL model; absent when none. */
  narrativeLocal?: boolean;
  /**
   * M88: fleet activity digest — per-repo proposal stats + daemon counters.
   * Absent when no fleet activity has occurred or the store is unavailable
   * (never-throws, best-effort). Included in --json output.
   */
  fleet?: import('./fleet/digest.js').FleetDigest;
}

/**
 * M29: outcome of deliverDigest — exactly what happened. The local artifact is
 * ALWAYS written; `notified` is true ONLY when `notify:true` was passed AND
 * notify() actually delivered to a configured webhook. METADATA ONLY.
 */
export interface DigestDeliveryResult {
  /** Absolute path of the JSON artifact written, or null on write failure. */
  jsonPath: string | null;
  /** Absolute path of the markdown artifact written, or null on write failure. */
  markdownPath: string | null;
  /**
   * Whether the digest was delivered outward via notify(). FALSE on the default
   * path (no --notify) and when no webhook is configured. The ONLY outward path.
   */
  notified: boolean;
}

// ---------------------------------------------------------------------------
// M31 — Agent-native surface: orient + native MCP tools
// ---------------------------------------------------------------------------

/**
 * M31: safety classification of a native MCP tool. The gate is STRUCTURAL —
 * `callNativeTool` enforces it before any handler runs:
 *   'read'     — pure read of local stores; allowed even when the kill switch is on.
 *   'append'   — append-only write under ~/.ashlr/ (genome hub); REFUSED when KILL.
 *   'proposal' — creates a PENDING inbox Proposal; REFUSED when KILL. There is
 *                deliberately NO 'approve'/'apply' class — approval is human-only.
 */
export type NativeToolSafety = 'read' | 'append' | 'proposal' | 'write' | 'exec';
// M42 extends the M31 set (additive — the structural gate `safety !== 'read'`
// already refuses the new classes under KILL):
//   'write' — mutates a workspace path (sandbox worktree); REFUSED under KILL,
//             boundary- + enrollment-gated. Opt-in via `ashlr run --engineer`.
//   'exec'  — runs a subprocess (bash/tests) confined to the sandbox worktree;
//             REFUSED under KILL; double opt-in via `--engineer --bash`.

/**
 * M31: one native tool served by the MCP gateway itself (SDK-free definition;
 * the gateway is the only adapter). `inputSchema` is plain JSON Schema.
 */
export interface NativeToolDef {
  /** Tool name, `ashlr_<verb>` — single underscore; downstream tools are `<server>__<tool>`. */
  name: string;
  /** Human/agent-facing description shown in tools/list. */
  description: string;
  /** JSON Schema for the arguments (always `type: 'object'`). */
  inputSchema: object;
  /** Safety class enforced by the call pipeline (see NativeToolSafety). */
  safety: NativeToolSafety;
}

/** M32: a percentile triple used by RunEstimate. */
export interface PercentileTriple {
  p25: number;
  median: number;
  p75: number;
}

/**
 * M32: pre-flight cost estimate for a run/swarm, derived from persisted
 * history (read-only, never throws — zeroed with confidence 'low' when no
 * history exists). Produced by core/observability/estimate.ts.
 */
export interface RunEstimate {
  kind: 'run' | 'swarm';
  goal: string;
  /** How many history samples informed the estimate. */
  sampleSize: number;
  /** low (<3 samples) · medium (<10) · high (≥10). */
  confidence: 'low' | 'medium' | 'high';
  tokens: PercentileTriple;
  steps: PercentileTriple;
  estCostUsd: PercentileTriple;
  /** Reference cloud cost of the median token volume (context for local $0). */
  wouldBeCloudUsd: number;
  durationMs: PercentileTriple;
  /** True when the requested budget capped the percentiles. */
  budgetClamped: boolean;
  generatedAt: string;
}

/**
 * M31: composite session-start orientation — "what should I know before I
 * start working here". Every section is BEST-EFFORT (empty on failure); the
 * builder never throws. READ-ONLY: derived entirely from local stores.
 */
export interface OrientResult {
  /** ISO timestamp the orientation was generated. */
  generatedAt: string;
  /** Absolute repo path the orientation is scoped to, or null for portfolio-wide. */
  repo: string | null;
  /** Top genome memory hits relevant to the repo/query (bounded). */
  genomeHits: { title: string; text: string; score: number; project: string | null }[];
  /** Latest health score for the repo (null when none recorded / not enrolled). */
  health: { score: number; grade: string; worstDimensions: string[] } | null;
  /** Top persisted backlog items for the repo (empty when no backlog built). */
  backlogItems: { id: string; source: string; title: string; score: number }[];
  /** Number of PENDING inbox proposals awaiting the human. */
  pendingProposals: number;
  /** Portfolio attention summary from the index (dirty/stale repo counts). */
  attention: { dirtyRepos: number; staleRepos: number } | null;
}
