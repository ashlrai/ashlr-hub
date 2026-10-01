/**
 * core/verse/agents/types.ts — "run many agents" (3.16): the wire contract
 * for the Agents board, one-click agent workspaces, the per-agent Checks tab,
 * Plan first and the per-agent spend cap.
 *
 * AN AGENT IS A CHAT PLUS (OPTIONALLY) A WORKSPACE. Every Verse chat shows on
 * the board; a chat started with "New agent" also owns a git worktree on a
 * `verse/<slug>` branch under the Verse-managed `~/.ashlr-worktrees`, the
 * repo's own setup / run / archive scripts (`.ashlr/verse/workspace.json`), a
 * block of ports, and the post-PR loop (Checks, Auto-fix CI, Auto-merge).
 *
 * NOTHING HERE STARTS A MODEL TURN ON ITS OWN AUTHORITY. Turns an agent makes
 * are the operator's: the prompt they typed (sent when setup finishes), the
 * plan they approved, or a CI failure log sent because THEY switched Auto-fix
 * on for that agent — each bounded by the agent's spend cap.
 *
 * BROWSER-SAFE: types and pure constants only.
 */
import type { VerseEngine } from '../types.js';

export const VERSE_AGENTS_PATH = '/api/verse/agents';

// ===========================================================================
// Workspace configuration — `.ashlr/verse/workspace.json` in the repo
// ===========================================================================

/** Where a repo describes its agent workspaces (repo-relative). */
export const WORKSPACE_CONFIG_RELATIVE_PATH = '.ashlr/verse/workspace.json';

/** Ports a workspace gets by default (Conductor's convention: ten in a row). */
export const DEFAULT_WORKSPACE_PORTS = 10;
export const MAX_WORKSPACE_PORTS = 50;
/** First port of the first block. Blocks are handed out upward from here. */
export const WORKSPACE_PORT_BASE = 41_000;
export const WORKSPACE_PORT_CEILING = 60_000;

/** Live agent workspaces kept before the oldest unpinned, idle one is archived. */
export const DEFAULT_WORKSPACE_CAP = 25;
/** Protocol bound, not a product roster ceiling. A signed-in operator can choose no retention cap. */
export const MAX_WORKSPACE_CAP = Number.MAX_SAFE_INTEGER;

/** Invalid overrides retain the established default rather than widening capacity. */
export function parseAgentWorkspaceCap(value: string | undefined): number {
  if (value?.trim().toLowerCase() === 'none') return MAX_WORKSPACE_CAP;
  if (!value?.trim()) return DEFAULT_WORKSPACE_CAP;
  const raw = Number(value);
  return Number.isSafeInteger(raw) && raw >= 1 ? raw : DEFAULT_WORKSPACE_CAP;
}

export const MAX_RUN_SCRIPTS = 8;
export const MAX_COPY_ENTRIES = 32;
export const MAX_SCRIPT_CHARS = 4_000;

export interface WorkspaceRunScript {
  /** Button label ("Dev server", "Storybook"). */
  name: string;
  command: string;
}

/** The parsed, validated `.ashlr/verse/workspace.json`. Every field optional in the file. */
export interface WorkspaceConfig {
  /** Runs once in a new workspace (install deps, seed a db). Gates the first prompt. */
  setup: string | null;
  /** Buttons on the agent (dev server, tests …), each run in a terminal tab. */
  run: WorkspaceRunScript[];
  /** Runs in the workspace just before it is archived (stop containers, drop a db). */
  archive: string | null;
  /** Repo-relative files copied from the main checkout into a new workspace (gitignored ones like `.env`). */
  copy: string[];
  /** Ports reserved for the workspace (ASHLR_PORT … ASHLR_PORT + ports − 1). */
  ports: number;
}

/** Where a config came from, so the UI can say "no workspace.json: defaults". */
export interface WorkspaceConfigRead {
  config: WorkspaceConfig;
  source: 'file' | 'default';
  /** Problems in the file (each field that was ignored, and why). Never a path. */
  warnings: string[];
}

/** The environment every workspace script (and the agent's terminal tabs) gets. */
export interface WorkspaceEnv {
  ASHLR_WORKSPACE_PATH: string;
  ASHLR_WORKSPACE_NAME: string;
  ASHLR_ROOT_PATH: string;
  ASHLR_PORT: string;
  ASHLR_PORT_COUNT: string;
}

// ===========================================================================
// Agent records (persisted in ~/.ashlr/verse/agents/agents.json)
// ===========================================================================

export type AgentPlanState = 'none' | 'drafting' | 'awaiting-approval' | 'approved';

export type ScriptKind = 'setup' | 'run' | 'archive';
export type ScriptState = 'running' | 'ok' | 'failed';

/** One setup / run / archive execution. */
export interface ScriptRunRecord {
  id: string;
  kind: ScriptKind;
  /** The run script's name; the kind for setup / archive. */
  name: string;
  /** `terminal` = a Terminal tab in the agent's chat; `process` = a background child with a captured log. */
  via: 'terminal' | 'process';
  tabId: string | null;
  state: ScriptState;
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
}

export interface AgentWorkspaceRecord {
  /** The main checkout the worktree came from (absolute). */
  rootPath: string;
  /** The worktree (absolute, under ~/.ashlr-worktrees). */
  path: string;
  /** `verse/<slug>`. */
  branch: string;
  /** The slug (directory + branch segment). */
  name: string;
  portBase: number;
  portCount: number;
  /** HEAD the worktree started from. */
  baseSha: string | null;
}

export interface AgentArchiveRecord {
  at: string;
  /** Private ref holding the snapshot (`refs/ashlr/verse-archive/<name>`). */
  ref: string | null;
  /** The snapshot commit (working changes included); null when there was nothing to keep. */
  sha: string | null;
  /** The branch head when it was archived (the snapshot's parent). */
  headSha: string | null;
  reason: 'manual' | 'merged' | 'cap';
  /** The branch was deleted (its commits live on in `ref`). */
  branchDeleted: boolean;
}

export interface AgentRecord {
  /** `ag_<random>`. */
  id: string;
  /** The Verse chat; null between "workspace created" and "chat bound". */
  sessionId: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
  pinned: boolean;
  workspace: AgentWorkspaceRecord | null;
  /** The first prompt, held until setup finishes (then sent and cleared). */
  pendingPrompt: string | null;
  plan: {
    enabled: boolean;
    state: AgentPlanState;
    /** The plan text as the seat wrote it, then as the operator edited it. */
    text: string | null;
    /** turnCount of the turn that wrote the plan. */
    turn: number | null;
  };
  /** USD at API list price (an equivalent: subscriptions are not billed per token). null = no cap. */
  spendCapUsd: number | null;
  /** Spend already warned about (80%) / stopped at (100%), so each fires once per cap. */
  spendWarnedAt: number | null;
  spendStoppedAt: number | null;
  autoFix: boolean;
  autoMerge: boolean;
  /** Head SHAs already sent to the seat as a CI failure (one fix attempt per head). */
  autoFixSentFor: string[];
  autoFixAttempts: number;
  /** The last thing the post-PR loop did or refused, in one sentence. */
  loopNote: string | null;
  scripts: ScriptRunRecord[];
  archived: AgentArchiveRecord | null;
  /** turnCount at which a failed turn was resolved by the operator (Needs you → out). */
  resolvedFailureTurn: number | null;
}

/** Most auto-fix attempts per PR before the agent goes to Needs you. */
export const MAX_AUTO_FIX_ATTEMPTS = 3;
/** Spend warning threshold (fraction of the cap). */
export const SPEND_WARN_FRACTION = 0.8;

// ===========================================================================
// The board (GET /api/verse/agents)
// ===========================================================================

export const AGENT_COLUMNS = ['working', 'needs-you', 'review', 'done'] as const;
export type AgentColumn = (typeof AGENT_COLUMNS)[number];

export const AGENT_COLUMN_LABEL: Readonly<Record<AgentColumn, string>> = {
  working: 'Working',
  'needs-you': 'Needs you',
  review: 'Ready for review',
  done: 'Done',
};

/** Why a card is where it is — the reason line the card shows. */
export type AgentReasonCode =
  | 'running'
  | 'setup-running'
  | 'ci-running'
  | 'plan-drafting'
  | 'failed'
  | 'plan-ready'
  | 'spend-cap'
  | 'setup-failed'
  | 'ci-failed'
  | 'merge-blocked'
  | 'unread'
  | 'changes'
  | 'pr-open'
  | 'merged'
  | 'archived'
  | 'idle';

export interface AgentChecksSummary {
  pr: { number: number; url: string; state: 'open' | 'draft' | 'merged' | 'closed'; title: string } | null;
  ci: 'passing' | 'failing' | 'pending' | 'none' | 'unknown';
  dirty: number;
  ahead: number;
  /** Unresolved review threads + change requests, when read. */
  comments: number | null;
  checkedAt: string | null;
}

export interface AgentSpend {
  /** USD at API list price; null when the model has no list price (local, Grok, Devin). */
  usd: number | null;
  capUsd: number | null;
  /** 0–1+ of the cap; null without both. */
  fraction: number | null;
  tokens: number;
}

export interface AgentCard {
  /** The agent id, or `chat:<sessionId>` for a chat with no agent record. */
  id: string;
  agentId: string | null;
  sessionId: string | null;
  title: string;
  column: AgentColumn;
  reason: AgentReasonCode;
  /** One line: why it is in this column, in operator language. */
  reasonText: string;
  seatId: string | null;
  engine: VerseEngine | null;
  model: string | null;
  repo: string | null;
  branch: string | null;
  workspacePath: string | null;
  status: 'idle' | 'running' | 'error' | 'setup' | 'archived';
  unread: boolean;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  /** When the current run started (running cards); null otherwise. */
  startedAt: string | null;
  /** The last thing it said or did, one line. */
  lastActivity: string | null;
  turnCount: number;
  spend: AgentSpend;
  checks: AgentChecksSummary | null;
  autoFix: boolean;
  autoMerge: boolean;
  plan: AgentRecord['plan'] | null;
  ports: { base: number; count: number } | null;
  runScripts: string[];
  scripts: ScriptRunRecord[];
  loopNote: string | null;
  /** The first prompt is held (setup running or failed): "Send anyway" can release it. */
  heldPrompt: boolean;
  archived: boolean;
  /** Archived with a snapshot: Restore brings the workspace back. */
  restorable: boolean;
}

export interface AgentBoardResponse {
  generatedAt: string;
  cards: AgentCard[];
  counts: Record<AgentColumn, number>;
  cap: number;
  /** Live (unarchived) agent workspaces. */
  liveWorkspaces: number;
  /** The post-PR loop is running in this server. */
  supervisor: boolean;
}

// ===========================================================================
// Requests
// ===========================================================================

/** POST /api/verse/agents/workspaces — make the worktree (the chat is created next, by the page). */
export interface AgentWorkspaceCreateRequest {
  root: string;
  /** Optional slug; derived from the title otherwise. */
  name?: string;
  title: string;
  planFirst?: boolean;
  spendCapUsd?: number | null;
  autoFix?: boolean;
  autoMerge?: boolean;
}

export interface AgentWorkspaceCreateResponse {
  agent: AgentRecord;
  config: WorkspaceConfigRead;
  /** Agents archived to stay under the cap. */
  archivedForCap: string[];
}

/** POST /api/verse/agents/:id/bind — attach the chat, and hand over the first prompt. */
export interface AgentBindRequest {
  sessionId: string;
  /** Held until setup finishes, then sent (as a plan request when Plan first is on). */
  prompt?: string;
}

/** POST /api/verse/agents/chat — adopt an existing chat (no workspace) so it can have toggles and a cap. */
export interface AgentAdoptRequest {
  sessionId: string;
}

/** POST /api/verse/agents/:id/settings */
export interface AgentSettingsUpdate {
  autoFix?: boolean;
  autoMerge?: boolean;
  spendCapUsd?: number | null;
  pinned?: boolean;
  title?: string;
}

/** POST /api/verse/agents/:id/plan — approve (optionally edited) or discard. */
export interface AgentPlanDecision {
  action: 'approve' | 'discard';
  text?: string;
}

/** GET /api/verse/agents/:id/checks */
export interface AgentChecksDetail {
  agentId: string | null;
  sessionId: string | null;
  root: string | null;
  branch: string | null;
  base: string | null;
  dirty: number;
  ahead: number;
  behind: number;
  diffstat: { files: number; additions: number; deletions: number } | null;
  pr: AgentChecksSummary['pr'] & { mergeable: boolean | null; headSha: string | null } | null;
  ci: AgentChecksSummary['ci'];
  checks: Array<{ name: string; state: 'passing' | 'failing' | 'pending' | 'skipped'; url: string | null }>;
  comments: Array<{ author: string; body: string; at: string | null; path: string | null; url: string | null }>;
  /** Auto-merge would do what, right now — in one sentence. */
  mergeVerdict: { allowed: boolean; reason: string };
  autoFix: boolean;
  autoMerge: boolean;
  loopNote: string | null;
  checkedAt: string;
  /** gh could not answer (signed out, no remote): the PR part is unknown, not "none". */
  unavailable: string | null;
}

export interface AgentScriptLog {
  run: ScriptRunRecord;
  /** The captured output tail (process runs; a terminal run's lives in its tab). */
  text: string;
  truncated: boolean;
}
