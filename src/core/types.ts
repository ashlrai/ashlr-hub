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
  };
  /** Map of integration name -> resolved executable path (entire, aw, claude, ...). */
  tools: Record<string, string>;
  /** Optional Phantom secrets integration toggle. */
  phantom?: { enabled: boolean };
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
  /** Existing run id to resume from cache. */
  resumeId?: string;
  /** Emit machine-readable JSON instead of human output. */
  json?: boolean;
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
