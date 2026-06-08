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
  /** Telemetry hooks (e.g. Pulse). All fields optional. */
  telemetry: {
    pulse?: string;
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
