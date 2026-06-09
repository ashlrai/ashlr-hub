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
  /** Engine that executed the run ('builtin' | 'ashlrcode' | 'aw'). */
  engine: string;
  /** Active provider id used for the run. */
  provider: string;
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
  method: 'heuristic' | 'model';
}

/** The set of engines `ashlr run` can delegate to (or run locally). */
export type EngineId = 'builtin' | 'ashlrcode' | 'aw' | 'claude';

/** A fully-resolved external engine invocation (exact argv + optional cwd). */
export interface EngineCommand {
  /** Executable to spawn (e.g. 'claude', 'aw', 'ac', or 'phantom' when wrapped). */
  bin: string;
  /** Exact argument vector passed to `bin`. */
  args: string[];
  /** Working directory for the spawned process, when set. */
  cwd?: string;
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
}

/** The selectable tabs of the interactive TUI dashboard. */
export type TuiTab = 'overview' | 'runs' | 'swarms' | 'pulse' | 'mcp';


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
