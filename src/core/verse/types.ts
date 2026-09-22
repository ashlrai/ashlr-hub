/**
 * Ashlr Verse — interactive multi-turn session contract (V1).
 *
 * A Verse session binds one project directory to one execution seat
 * (engine + account + model). Each user turn spawns ONE vendor CLI process
 * that resumes the vendor-native conversation by id, streams normalized
 * events, and exits. No long-lived stdin is held between turns.
 *
 * Seats:
 *   claude  -> `claude -p ... --output-format stream-json` via a native-profile launcher (account pinned by CLAUDE_CONFIG_DIR)
 *   local   -> the plain `claude` binary with ANTHROPIC_BASE_URL pointed at Ollama (Anthropic-compatible API); model = Ollama tag
 *   codex   -> `codex exec --json` / `codex exec resume <threadId> --json` via a native-profile launcher (CODEX_HOME pinned)
 *   grok    -> `grok -p ... --output-format streaming-messages-json` via a native-profile launcher (GROK_HOME pinned)
 *
 * Nothing in this module reads secrets. Account identity is pinned by the
 * launcher command recorded in ~/.ashlr/account-connections/connections.json.
 */

export type VerseEngine = 'claude' | 'codex' | 'grok' | 'local';

export type VerseSessionStatus = 'idle' | 'running' | 'error';

/** One selectable execution seat shown in the model/account picker. */
export interface VerseSeat {
  /** Stable id, e.g. `claude`, `codex-personal`, `grok`, `local:qwen3-coder-next:ctx64k`. */
  id: string;
  engine: VerseEngine;
  /** Human label, e.g. "Claude Code", "Personal Codex", "Grok", "Qwen3-Coder-Next (local)". */
  label: string;
  /** Account id from connections.json for native seats; `local` for Ollama seats. */
  accountId: string;
  /** Models this seat can run. First entry is the default. */
  models: VerseModelOption[];
  /** Best-known context window in tokens for the default model (null when unknown). */
  contextWindow: number | null;
  /** Latest health/usage evidence, if any. Never an admission input in V1. */
  health: VerseSeatHealth;
  /**
   * V2.1 ADDITIVE. The subscription capacity behind this seat, so the seat
   * list can render a meter without a second request.
   *
   * Absent (`undefined`) for LOCAL seats: an Ollama tag has no subscription
   * and no provider window. Its real constraint is machine memory, which is
   * reported by `VerseBootstrap.localRuntime`, not by a quota. Absent on a
   * native seat means the server could not build a record for that account
   * at all — `health.state` says what it does know.
   */
  capacity?: VerseSeatCapacity;
}

export interface VerseModelOption {
  id: string;
  label: string;
  contextWindow: number | null;
}

export interface VerseSeatHealth {
  state: 'ready' | 'degraded' | 'unavailable' | 'unknown';
  /** e.g. "5h window 72% used, resets 14:00" — plain text, already sanitized. */
  summary: string | null;
  windows: Array<{ id: string; usedPercent: number | null; resetsAt: string | null }>;
  observedAt: string | null;
}

// ---------------------------------------------------------------------------
// Seat capacity (V2.1, additive) — see docs/VERSE-TELEMETRY-V2.md, which is
// the authority for every honesty rule encoded in these shapes.
//
// This file is imported by the BROWSER bundle, so it may not import
// `core/verse/accounts.ts` (node:fs). The shapes below therefore restate the
// provider-record shapes structurally. `seats.ts` assigns the account record's
// values straight into them, so a divergence in `core/verse/accounts.ts` stops
// `seats.ts` compiling — that assignment is the drift guard.
// ---------------------------------------------------------------------------

/** One provider-reported quota window, as carried on a seat. */
export interface VerseSeatWindow {
  id: string;
  /** Provider-reported percent, or null for NO SIGNAL — which is not zero. */
  usedPercent: number | null;
  /**
   * Machine-readable reset instant. STRUCTURALLY ALWAYS NULL for Claude: that
   * provider publishes only a sentence, which lives in `resetDescription` and
   * is rendered verbatim. Never synthesize a countdown from a description.
   */
  resetsAt: string | null;
  /** The provider's own reset wording, verbatim ("resets Sep 25 at 7pm (America/New_York)"). */
  resetDescription: string | null;
  /**
   * TRUE only when the provider explicitly FLAGGED the limit. Such a window's
   * `usedPercent` is the SENTINEL 100 — a denial, not a measurement — and must
   * be labelled "limit reached", never "100% used".
   */
  limitReached: boolean;
  /** False when `usedPercent` is a flagged sentinel rather than a reading. */
  measured: boolean;
}

/**
 * Codex credits, INDEPENDENT of the window: a fully used weekly window with a
 * spendable balance is not blocked. `null` is "no signal", never "no credits".
 */
export interface VerseSeatCredits {
  hasCredits: boolean;
  unlimited: boolean;
  /** Provider-reported decimal string, kept verbatim — never rounded. */
  balance: string | null;
}

/**
 * The coarse "can I use this seat right now" verdict. Deliberately coarse: the
 * exact numbers are in `windows`, and a verdict that pretended to more
 * precision than the providers give would be a lie.
 *
 * - `ready`      — a reading exists and the binding window has headroom.
 * - `tight`      — the binding window is at/above the warn threshold, OR it is
 *                  spent while Codex credits remain spendable (not blocked).
 * - `exhausted`  — the binding window is spent and nothing else is left.
 * - `signed-out` — the account is not authenticated; reconnect it.
 * - `unknown`    — NO window carried a percent. Not zero, not healthy.
 */
export type VerseSeatUsability = 'ready' | 'tight' | 'exhausted' | 'signed-out' | 'unknown';

/**
 * Where a seat's windows came from, so nothing implies freshness it lacks.
 * Mirrors `VerseEvidenceSource` in `core/verse/accounts.ts`.
 */
export type VerseSeatEvidenceSource = 'collector' | 'shared-evidence' | 'baseline' | 'none';

/** Everything the seat list needs to draw a capacity meter honestly. */
export interface VerseSeatCapacity {
  /** e.g. "max", "pro", "SuperGrok". Null when the provider gave none. */
  planType: string | null;
  /**
   * THE CONSTRAINT THAT ACTUALLY BLOCKS WORK: the window with the highest
   * `usedPercent`. Null when no window carried a percent at all.
   */
  binding: VerseSeatWindow | null;
  /** Every window the provider reported, in provider order. */
  windows: VerseSeatWindow[];
  /** Codex only; null for every other provider and when no signal exists. */
  credits: VerseSeatCredits | null;
  usability: VerseSeatUsability;
  observedAt: string | null;
  evidenceSource: VerseSeatEvidenceSource;
  /** Plain-language provider facts the UI must show instead of implying a fault. */
  notes: string[];
}

export interface VerseProject {
  path: string;
  name: string;
  /** From ~/.ashlr/enrollment.json when present. */
  enrolled: boolean;
}

// ---------------------------------------------------------------------------
// Workspaces (V2.2, ADDITIVE) — see docs/VERSE-WORKSPACES.md §1.
//
// A session bound to ONE directory cannot express "this service plus the
// shared library it depends on", which is most real work. A workspace is a
// NAMED set of roots with exactly one marked primary.
//
// `VerseSession.projectPath` keeps its meaning — it IS the primary root — so
// every session record, adapter and test written before workspaces existed
// still loads and still runs. Nothing rewrites saved chat history.
//
// ENROLLMENT IS NOT PART OF THIS SHAPE ON PURPOSE. A workspace says what a
// session may REACH; `~/.ashlr/enrollment.json` says what the AUTONOMOUS lane
// may mutate, and the two are deliberately separate registries. Membership in
// a workspace grants no enrollment: `enrolled` below is READ from the
// registry per root and is never written by anything in this feature.
// ---------------------------------------------------------------------------

/** One directory in a workspace. Exactly one root in a workspace is primary. */
export interface VerseWorkspaceRoot {
  /** Absolute, physically resolved path (symlinks followed). */
  path: string;
  /** Display name; defaults to the basename. */
  name: string;
  /**
   * The session's cwd and the value `projectPath` carries. Exactly one root
   * per workspace has this set.
   */
  primary: boolean;
}

/**
 * A named set of roots.
 *
 * ONE TYPE, TWO USES, DELIBERATELY. An interactive session binds to a
 * workspace to decide what it can reach; the autonomous lane reads the same
 * workspace as a SECTION — "these repositories collaborate, work on them
 * together" — when `section` is true. They were not split because the thing
 * being named is identical in both: a set of directories that belong to one
 * piece of work. Two registries of named repo groups would drift.
 *
 * What is NOT on this type is priority. A repo may belong to several
 * workspaces, so a per-membership rank would give one repo several
 * contradictory ranks. Priority is therefore an attribute OF THE REPO, held
 * once per path in the same registry — see `VerseRootPriority`.
 */
export interface VerseWorkspace {
  id: string;
  name: string;
  /** Primary first, then the extras in the order they were added. */
  roots: VerseWorkspaceRoot[];
  /**
   * Offer this workspace to the autonomous lane as a section.
   *
   * GRANTS NOTHING. The fleet still reaches only what
   * `~/.ashlr/enrollment.json` permits; a section can group and order those
   * repos and nothing else. A member that is not enrolled stays unreachable.
   */
  section: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Relative standing of one repository in the autonomous lane's attention.
 *
 * ORDERING ONLY, NEVER ADMISSION. `critical` on an unenrolled repo is still
 * refused by `assertMayMutate`; `low` on an enrolled one is still permitted.
 * An ordinal rather than a number because the operator's judgement here is
 * "this matters more than that", and a 0-100 score would invent a precision
 * nobody holds.
 *
 * Absent means `normal`, which is how every repo already behaves — so a
 * registry with no priorities at all reproduces today's flat list exactly.
 */
export type VerseRootPriority = 'critical' | 'high' | 'normal' | 'low';

export const VERSE_ROOT_PRIORITIES: readonly VerseRootPriority[] =
  ['critical', 'high', 'normal', 'low'];

export const VERSE_DEFAULT_ROOT_PRIORITY: VerseRootPriority = 'normal';

/** Sort weight; lower sorts first. Never a budget, never a multiplier. */
export const VERSE_ROOT_PRIORITY_RANK: Record<VerseRootPriority, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

/** One enrolled repository as the autonomy scope view ranks it. */
export interface VerseAutonomyScopeEntry {
  path: string;
  name: string;
  priority: VerseRootPriority;
  /** Sections (workspaces with `section: true`) this repo belongs to. */
  sections: Array<{ id: string; name: string }>;
  /** True when a focus section is set and this repo is outside it. */
  outsideFocus: boolean;
}

/**
 * The autonomous lane's scope, ORDERED.
 *
 * Built by INTERSECTING section membership with the enrollment registry, so
 * it can only ever be a subset of what enrollment already allows. Sections
 * add ordering and grouping; they never add reach.
 */
export interface VerseAutonomyScopeView {
  focusSectionId: string | null;
  focusSectionName: string | null;
  /** Enrolled repos, most important first. */
  entries: VerseAutonomyScopeEntry[];
  /**
   * Paths a section names that are NOT enrolled. Listed so the blast radius
   * is legible in both directions — these are exactly the repos a section
   * does NOT give the fleet.
   */
  unenrolledSectionRoots: string[];
}

/**
 * Per-root git identity. A turn that edits two repos produces two diffs, so
 * the transcript has to be able to attribute each file to the right one.
 *
 * `remote` is the canonical `owner/repo` for a GitHub origin and null for
 * anything else — deliberately NOT the raw remote URL, which can carry a
 * token in its userinfo and would then reach an API response.
 */
export interface VerseRootGit {
  branch: string;
  /** Count of porcelain entries; 0 is clean. */
  dirty: number;
  ahead: number;
  behind: number;
  remote: string | null;
}

/** A root as the client sees it: identity, reachability and honest scope. */
export interface VerseRootStatus {
  path: string;
  name: string;
  primary: boolean;
  exists: boolean;
  /**
   * Read live from the enrollment registry. FALSE means the interactive lane
   * still works on this root while the autonomous lane refuses it — being in
   * a workspace never changes this.
   */
  enrolled: boolean;
  /** Null when the root is not a git repository, or git is unavailable. */
  git: VerseRootGit | null;
  /**
   * False when the session's engine has no way to be granted this root (Grok's
   * CLI exposes `--cwd` and nothing else). The root is still listed, because
   * hiding it would misrepresent what the workspace is.
   */
  reachable: boolean;
}

/** GET /api/verse/sessions/:id/roots */
export interface VerseSessionRootsResponse {
  sessionId: string;
  workspaceId: string | null;
  workspaceName: string | null;
  roots: VerseRootStatus[];
  /**
   * Plain-language facts the UI must show rather than imply: an unreachable
   * root on a Grok seat, or a root the autonomous lane will refuse.
   */
  notes: string[];
}

/** GET /api/verse/workspaces */
export interface VerseWorkspacesResponse {
  workspaces: VerseWorkspace[];
  /** Live per-root facts, keyed by workspace id, so one read draws the list. */
  status: Record<string, VerseRootStatus[]>;
  /** Per-repo priority, keyed by canonical path. Absent key means `normal`. */
  priorities: Record<string, VerseRootPriority>;
  focusSectionId: string | null;
}

/** POST /api/verse/workspaces */
export interface VerseWorkspaceCreateRequest {
  name: string;
  /** Absolute paths. The first is the primary. */
  roots: string[];
  /** Also offer this set to the autonomous lane as a section. Default false. */
  section?: boolean;
}

/** POST /api/verse/workspaces/:id/update */
export interface VerseWorkspaceUpdateRequest {
  name?: string;
  /** When present, replaces the root set wholesale. First entry is primary. */
  roots?: string[];
  section?: boolean;
}

/** POST /api/verse/workspaces/priority */
export interface VerseRootPriorityRequest {
  path: string;
  priority: VerseRootPriority;
}

/** POST /api/verse/workspaces/focus — `sectionId: null` clears the focus. */
export interface VerseFocusSectionRequest {
  sectionId: string | null;
}

/** Hard cap on roots per workspace — a blast radius, not a UI limit. */
export const VERSE_MAX_WORKSPACE_ROOTS = 8;

/**
 * Every root a session can reach, primary first.
 *
 * Pure and total: a record written before workspaces existed has no
 * `extraRoots` and yields exactly `[projectPath]`, which is what every caller
 * assumed before this existed.
 */
export function verseSessionRoots(
  session: Pick<VerseSession, 'projectPath' | 'extraRoots'>,
): string[] {
  const out = [session.projectPath];
  for (const root of session.extraRoots ?? []) {
    if (typeof root === 'string' && root.length > 0 && !out.includes(root)) out.push(root);
  }
  return out;
}

export interface VerseUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Prompt size of the most recent assistant call = live context occupancy. */
  contextTokens: number;
  contextWindow: number | null;
}

export interface VerseSession {
  id: string;
  title: string;
  /**
   * The PRIMARY root: the process cwd and the folder every pre-workspace
   * client already reads. Unchanged in meaning, which is why no session
   * record ever has to be rewritten.
   */
  projectPath: string;
  /**
   * V2.2 ADDITIVE. Roots BEYOND the primary, pinned at creation time.
   *
   * Absent on every record written before workspaces existed, and absent on
   * a single-root session today — so the on-disk shape of an ordinary chat
   * does not change at all.
   *
   * PINNED, not referenced: a session keeps the roots it was created with
   * even if the named workspace is later edited or deleted, for the same
   * reason `launch.anthropicBaseUrl` is pinned — a conversation must not
   * silently gain reach because config moved underneath it.
   */
  extraRoots?: string[];
  /** V2.2 ADDITIVE. Provenance of the pinned roots; absent for an ad-hoc set. */
  workspaceId?: string;
  workspaceName?: string;
  engine: VerseEngine;
  accountId: string;
  seatId: string;
  model: string;
  /** Vendor conversation id used for resume (claude/grok: our uuid; codex: thread id from output). */
  nativeSessionId: string | null;
  createdAt: string;
  updatedAt: string;
  status: VerseSessionStatus;
  turnCount: number;
  usage: VerseUsage;
  lastError: string | null;
}

/** Normalized event stream. `seq` is monotonic per session and is the SSE id. */
export type VerseEvent =
  | { seq: number; at: string; type: 'user-message'; turnId: string; text: string }
  | { seq: number; at: string; type: 'turn-started'; turnId: string; pid: number | null }
  | { seq: number; at: string; type: 'text-delta'; turnId: string; text: string }
  | { seq: number; at: string; type: 'assistant-message'; turnId: string; text: string }
  | { seq: number; at: string; type: 'thinking'; turnId: string; text: string }
  | { seq: number; at: string; type: 'tool-use'; turnId: string; toolUseId: string; name: string; input: unknown }
  | { seq: number; at: string; type: 'tool-result'; turnId: string; toolUseId: string; output: string; isError: boolean }
  | { seq: number; at: string; type: 'usage'; turnId: string; usage: VerseUsage }
  | { seq: number; at: string; type: 'turn-done'; turnId: string; ok: boolean; nativeSessionId: string | null; durationMs: number }
  | { seq: number; at: string; type: 'error'; turnId: string | null; message: string }
  | { seq: number; at: string; type: 'cancelled'; turnId: string };

export type VerseEventType = VerseEvent['type'];

/**
 * Which endpoint a LOCAL seat sends its turns to.
 *
 *  - `ollama`       — the historical lane: the plain `claude` binary with
 *                     ANTHROPIC_BASE_URL pointed straight at Ollama's
 *                     Anthropic-compatible endpoint on :11434. Ollama
 *                     serialises this model architecture, so a fleet of local
 *                     agents on this lane is a queue (docs/LOCAL-FLEET.md).
 *  - `llama-server` — the same binary pointed at the local Anthropic
 *                     normalising proxy that fronts llama-server. That proxy
 *                     is the ONLY way to reach llama-server's parallel slots
 *                     and the prompt-cache fix, because Qwen3.8's chat
 *                     template rejects Claude Code's request shape unless the
 *                     proxy rewrites it on the way through.
 *
 * DISPATCH ONLY. Model DISCOVERY stays on Ollama in both lanes — llama-server
 * implements neither `/api/tags` nor `/api/show`, which is where every local
 * seat's identity, context window and `tools` capability comes from.
 */
export type VerseLocalDispatch = 'ollama' | 'llama-server';

/** What a client is told about this machine's local serving situation. */
export interface VerseLocalRuntimeSummary {
  /** Ollama reachable? Drives the local seats and an inline hint when false. */
  ollama: { reachable: boolean; baseUrl: string; models: string[] };
  /**
   * Where local seats DISPATCH turns, reported only when that is NOT the
   * default Ollama lane.
   *
   * Absent means `ollama`, i.e. exactly what every existing client already
   * assumes — so opting in is visible on the wire and NOT opting in changes no
   * payload at all.
   */
  dispatch?: { lane: VerseLocalDispatch; baseUrl: string };
}

/** GET /api/verse/bootstrap */
export interface VerseBootstrap {
  seats: VerseSeat[];
  projects: VerseProject[];
  sessions: VerseSession[];
  /** Whether POST routes are enabled on this server (`ashlr serve --allow-dispatch` / `ashlr verse`). */
  dispatchEnabled: boolean;
  localRuntime: VerseLocalRuntimeSummary;
}

/**
 * GET /api/verse/seats (V2.1)
 *
 * WHY THIS ROUTE EXISTS: `bootstrap` is a MOUNT-TIME snapshot. A client that
 * opened the app before the collector's first cycle finished would show
 * "unknown" forever. This is the same seat list, cheap enough to poll, and it
 * always reflects the collector's CURRENT state rather than a cached one.
 */
export interface VerseSeatsResponse {
  /** When this body was built. */
  sampledAt: string;
  seats: VerseSeat[];
  localRuntime: VerseBootstrap['localRuntime'];
}

/**
 * POST /api/verse/sessions
 *
 * Two spellings, never mixed (the API rejects the mix rather than silently
 * preferring one):
 *   - `workspaceId` alone — the named workspace supplies primary and extras.
 *   - `projectPath` (+ optional `extraRoots`) — an ad-hoc set, which is also
 *     exactly the pre-workspace request shape.
 */
export interface VerseCreateSessionRequest {
  projectPath: string;
  seatId: string;
  model?: string;
  title?: string;
  /** V2.2 ADDITIVE. Absolute paths beyond the primary. */
  extraRoots?: string[];
  /** V2.2 ADDITIVE. Bind to a named workspace instead of naming paths. */
  workspaceId?: string;
  /**
   * SERVER-FILLED. The API resolves this from the registry once `workspaceId`
   * is validated, and never reads it off the request body — so a session can
   * not be labelled with a workspace name that is not the one it was built
   * from.
   */
  workspaceName?: string;
}

/** POST /api/verse/sessions/:id/turns */
export interface VerseTurnRequest {
  text: string;
}
export interface VerseTurnResponse {
  turnId: string;
  session: VerseSession;
}

/** GET /api/verse/sessions/:id */
export interface VerseSessionDetail {
  session: VerseSession;
  events: VerseEvent[];
}

/** Adapter input: how to launch one turn. Pure data, produced by the engine, consumed by the spawner. */
export interface VerseTurnLaunch {
  argv: string[];
  cwd: string;
  /** Extra env layered over a minimal base (PATH/HOME/TMPDIR/LANG). Never contains secrets. */
  env: Record<string, string>;
  /** Text written to stdin (codex); null when the prompt is in argv. */
  stdin: string | null;
}

export const VERSE_MAX_TURN_TEXT_BYTES = 64 * 1024;
export const VERSE_MAX_EVENTS_PER_SESSION = 20_000;
export const VERSE_TURN_TIMEOUT_MS = 30 * 60 * 1000;
export const VERSE_DEFAULT_CONTEXT_WINDOWS: Record<string, number> = {
  claude: 200_000,
  codex: 272_000,
  grok: 256_000,
  local: 65_536,
};
