/**
 * Ashlr Verse — autonomy control-plane contract (V2).
 *
 * V1 (`./types.ts`) is frozen: it describes interactive chat sessions. This
 * module adds the shapes the Autonomy cockpit needs to run the hub's existing
 * autonomous fleet without a terminal — the CONFIGURED caps, the enrollment
 * scope, the audit trail, the kill switch, and the daemon lifecycle.
 *
 * Two hard rules are encoded here rather than left to the UI:
 *
 *  1. The global kill switch (`~/.ashlr/KILL`) is an EMERGENCY STOP, not a
 *     pause. It also refuses the agent's own `mcp-native` write tools. Every
 *     shape that carries it is named `killSwitch`, and the action that engages
 *     it is named `emergencyStop`. It is never called "pause".
 *
 *     V2.1 adds the control that name was being withheld from: the
 *     DAEMON-SCOPED pause (`~/.ashlr/daemon.paused`, see core/daemon/pause.ts).
 *     It halts autonomous dispatch and NOTHING else — `assertMayMutate`,
 *     `mcp-native`, and `mcp-native-engineer` do not read it. It travels as
 *     `pause: VerseDaemonPause`, always a FIELD OF ITS OWN, never merged into
 *     `killSwitch`, because the whole point is that the two have different
 *     blast radii and the operator must be able to see which one is on.
 *  2. Nothing in this module is a secret. Launcher commands, tokens, and env
 *     values never appear in any of these shapes — the daemon lifecycle result
 *     carries a pid, never an argv.
 *
 * Everything is a projection of state the hub already computes; nothing here
 * introduces a new source of truth.
 */

import type { AuditEntry } from '../types.js';
import type { PublicDaemonObservation } from '../daemon/public-observation.js';
import type { FrontierEngineUsage } from '../usage/frontier-usage.js';
import type { SafetyReport } from '../../cli/verify-safety.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Error codes for `/api/verse/{control,caps,scope,audit,daemon,safety}`.
 * `VERSE_INVALID` / `VERSE_TOO_LARGE` are deliberately the SAME codes V1 uses,
 * so one client error mapper covers both halves of the Verse API.
 */
export type VerseControlErrorCode =
  | 'VERSE_INVALID'
  | 'VERSE_REFUSED'
  | 'VERSE_TOO_LARGE'
  | 'VERSE_UNAVAILABLE';

/** Every error body on these routes. */
export interface VerseControlError {
  error: string;
  code: VerseControlErrorCode;
}

// ---------------------------------------------------------------------------
// Caps — the CONFIGURED limits (GET/POST /api/verse/caps)
// ---------------------------------------------------------------------------

/** One `cfg.foundry.limits[engine]` entry, flattened for transport. */
export interface VerseFoundryLimit {
  /** EngineId key, e.g. 'claude' | 'codex'. */
  engine: string;
  /** Rolling window label, e.g. '1m' | '5m' | '1h' | '1d'. */
  window: string;
  /** Max dispatches per window. 0 means "no dispatches allowed". */
  max: number;
}

/** `cfg.daemon.concurrency` — null per tier means "not configured, using the default". */
export interface VerseCapsConcurrency {
  local: number | null;
  cloud: number | null;
  total: number | null;
}

/**
 * The configured autonomy limits. These are the values the daemon actually
 * reads — no route exposed them before V2, which is why the cockpit could not
 * show a cap next to the usage burning against it.
 */
export interface VerseCaps {
  /** HARD daily spend ceiling (USD). 0 means the daemon is stopped by budget. */
  dailyBudgetUsd: number;
  /** Backlog items processed per tick. */
  perTickItems: number;
  /** Concurrent sandboxed swarms per tick (batch mode). */
  parallel: number;
  /** Tick interval in loop mode (ms). */
  intervalMs: number;
  /** Daemon execution mode. */
  mode: 'batch' | 'continuous';
  /** Ceiling on in-flight dispatches in continuous mode; null when unset. */
  maxConcurrent: number | null;
  /** Per-tier concurrency budgets; null per tier when unset. */
  concurrency: VerseCapsConcurrency;
  /** Subscription-window throttle percentage (1–100). */
  subscriptionMaxPercent: number;
  /** Per-engine dispatch limits, sorted by engine id. */
  foundryLimits: VerseFoundryLimit[];
  /**
   * HONEST STATE: the cap keys whose value is a built-in default rather than
   * something configured on disk. The UI renders these as "default", never as
   * a deliberate choice the operator made. Sorted, stable.
   */
  defaulted: VerseCapKey[];
}

/** The scalar cap keys a client may update. `foundryLimits` is handled separately. */
export type VerseCapKey =
  | 'dailyBudgetUsd'
  | 'perTickItems'
  | 'parallel'
  | 'intervalMs'
  | 'mode'
  | 'maxConcurrent'
  | 'concurrency'
  | 'subscriptionMaxPercent'
  | 'foundryLimits';

/** POST /api/verse/caps — a partial update. Unknown keys are rejected. */
export interface VerseCapsUpdate {
  dailyBudgetUsd?: number;
  perTickItems?: number;
  parallel?: number;
  intervalMs?: number;
  mode?: 'batch' | 'continuous';
  maxConcurrent?: number;
  concurrency?: { local?: number; cloud?: number; total?: number };
  subscriptionMaxPercent?: number;
  /** Replaces the named engines' limits; engines not listed are left alone. */
  foundryLimits?: VerseFoundryLimit[];
}

/**
 * POST /api/verse/caps result. `live: true` is not decoration — the daemon
 * re-reads config at the top of every tick, so a saved cap binds on the next
 * tick without a restart.
 */
export interface VerseCapsUpdateResult {
  ok: true;
  /** The cap keys this request actually changed, in request order. */
  applied: VerseCapKey[];
  live: true;
  /** The full caps AFTER the write, re-read from disk. */
  caps: VerseCaps;
}

// ---------------------------------------------------------------------------
// Scope — the enrollment registry (GET/POST /api/verse/scope)
// ---------------------------------------------------------------------------

export interface VerseScopeRepo {
  path: string;
  name: string;
  /** False when the registry still lists a directory that is gone. */
  exists: boolean;
}

/**
 * GET /api/verse/scope. An EMPTY `repos` with no `degradedReason` is the
 * valid default state and means the daemon will do nothing at all — the UI
 * must say that plainly rather than rendering an innocuous empty list.
 */
export interface VerseScope {
  repos: VerseScopeRepo[];
  /** Present only when enrollment authority could not be read at all. */
  degradedReason?: string;
}

export type VerseScopeAction = 'enroll' | 'unenroll';

/** POST /api/verse/scope body. */
export interface VerseScopeRequest {
  action: VerseScopeAction;
  path: string;
}

export interface VerseScopeResult {
  ok: boolean;
  action: VerseScopeAction;
  /** The canonical (realpath'd) registry path this acted on. */
  path: string;
  /** False when the registry already had the requested state (idempotent). */
  changed: boolean;
  /** Policy reason string, e.g. 'enrolled' | 'already-unenrolled'. */
  reason: string;
  /** The scope AFTER the mutation. */
  scope: VerseScope;
}

// ---------------------------------------------------------------------------
// Audit (GET /api/verse/audit)
// ---------------------------------------------------------------------------

export type VerseAuditResult = AuditEntry['result'];

/** GET /api/verse/audit?limit=&action=&result= */
export interface VerseAuditResponse {
  /** Newest first, already filtered, at most `limit` entries. */
  entries: AuditEntry[];
  /** The effective cap applied to `entries` (never above 500). */
  limit: number;
  /** Echo of the applied filter so the UI cannot drift from what it shows. */
  filter: { action: string | null; result: VerseAuditResult | null };
  /** How many raw entries were scanned before filtering. */
  scanned: number;
  /**
   * True when the scan filled its own ceiling, so older entries MAY exist
   * beyond what was read. Conservative by design: it never claims the reader
   * reached the end of history when it cannot prove that.
   */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------

/**
 * The GLOBAL kill switch (`~/.ashlr/KILL`). `state: 'unknown'` is a real,
 * distinct outcome — the sentinel was uninspectable — and must never be
 * rendered as "off".
 */
export interface VerseKillSwitch {
  state: 'active' | 'inactive' | 'unknown';
  sourceState: 'healthy' | 'degraded';
  reason: string;
  /**
   * Plain-language statement of blast radius, shipped with the state so no
   * surface can show the switch without the warning.
   */
  note: string;
}

// ---------------------------------------------------------------------------
// Daemon pause — the NARROW stop (POST /api/verse/daemon {action:'pause'})
// ---------------------------------------------------------------------------

/**
 * The DAEMON-SCOPED pause sentinel (`~/.ashlr/daemon.paused`), projected for
 * transport. Shares `VerseKillSwitch`'s shape on purpose — both are sentinels
 * read the same way, and both keep `'unknown'` as a real third state that must
 * never render as "off".
 *
 * `state: 'unknown'` is treated by the daemon as PAUSED (fail safe), so the UI
 * must say "paused — the sentinel could not be read", not "running".
 *
 * The sentinel PATH is deliberately absent: it is machine-local detail the
 * cockpit has no use for, the same omission `VerseKillSwitch` makes.
 */
export interface VerseDaemonPause {
  /** 'paused' = dispatch halted. 'running' = proven not paused. */
  state: 'paused' | 'running' | 'unknown';
  sourceState: 'healthy' | 'degraded';
  reason: string;
  /** ISO time the pause was requested; null when not paused or unknown. */
  pausedAt: string | null;
  /** Which surface paused it ('cli' | 'verse-control-plane' | 'unknown'). */
  by: string | null;
  /** Plain-language statement of the NARROW blast radius, shipped with the state. */
  note: string;
}

// ---------------------------------------------------------------------------
// Daemon lifecycle (POST /api/verse/daemon)
// ---------------------------------------------------------------------------

/**
 * 'start' launches the autonomous loop detached (exactly `ashlr daemon start`).
 * 'once' runs a single tick the same way.
 *
 * Three stops, three honestly different scopes:
 *   - 'pause'  — halts autonomous DISPATCH only. Reversible with 'resume'.
 *                Leaves the agent's own write tools alone. The default choice.
 *   - 'stop'   — the ordinary stop, which today engages the GLOBAL kill switch
 *                (`stopDaemon()` is `setKill(true)`), so it is wider than a
 *                pause and the result's `note` says so.
 *   - emergency stop — not on this route at all (`POST /api/fleet/pause`).
 */
export type VerseDaemonAction = 'start' | 'stop' | 'once' | 'pause' | 'resume';

/** Non-secret projection of `~/.ashlr/daemon.json`. */
export interface VerseDaemonStateProjection {
  running: boolean;
  pid: number | null;
  startedAt: string | null;
  lastTickAt: string | null;
  todayDate: string | null;
  todaySpentUsd: number;
  itemsProcessed: number;
}

/**
 * POST /api/verse/daemon result. `pid` is the only thing that ever escapes the
 * spawn — the argv, the env, and the resolved launcher path never do.
 */
export interface VerseDaemonActionResult {
  ok: boolean;
  action: VerseDaemonAction;
  /** True when a detached child was launched by this request. */
  spawned: boolean;
  /** The detached child's pid for 'start'/'once'; null otherwise. */
  pid: number | null;
  state: VerseDaemonStateProjection;
  killSwitch: VerseKillSwitch;
  /** The daemon-scoped pause AFTER this action. Never folded into killSwitch. */
  pause: VerseDaemonPause;
  /** One line of plain language about what just happened, for the UI to echo. */
  note: string;
}

// ---------------------------------------------------------------------------
// Fleet essentials + control aggregate (GET /api/verse/control)
// ---------------------------------------------------------------------------

/**
 * The small honest slice of FleetStatus/ControlSnapshot the cockpit needs.
 * Deliberately excludes service file paths and error-log paths: the cockpit
 * does not need them, and keeping them out keeps this payload trivially
 * provable as free of machine-local command detail.
 */
export interface VerseFleetEssentials {
  /** Mode the autonomy control loop last directed, when known. */
  directionMode: string | null;
  directionAt: string | null;
  directionReason: string | null;
  autonomyControlLoop: boolean;
  autonomyControlMode: string;
  service: {
    registrationState: 'present' | 'absent' | 'unknown';
    installed: boolean;
    running: boolean;
    runtimeState: string | null;
  };
  /** Freshness of the shared fleet-status cache backing these values. */
  freshness: { stale: boolean; ageMs: number };
}

/** Today's spend against the configured ceiling. */
export interface VerseSpend {
  /** null when the daemon ledger could not be read (NOT zero). */
  todayUsd: number | null;
  /** Calendar day the counter applies to; null before the first tick. */
  todayDate: string | null;
  dailyBudgetUsd: number;
}

/**
 * GET /api/verse/control — the ONE aggregate the Autonomy view reads.
 * Every field is a projection of an existing snapshot; nothing is recomputed.
 */
export interface VerseControlSnapshot {
  generatedAt: string;
  daemon: PublicDaemonObservation;
  fleet: VerseFleetEssentials;
  caps: VerseCaps;
  scope: VerseScope;
  killSwitch: VerseKillSwitch;
  /**
   * The DAEMON-SCOPED pause, as its own field. A cockpit that folded this into
   * `killSwitch` would be back to one control with two names; keeping them
   * separate is what lets the Autonomy view render "paused" and "kill switch
   * engaged" as the different situations they are.
   */
  pause: VerseDaemonPause;
  /** Pending inbox proposals awaiting a human decision. */
  pendingApprovals: number;
  spend: VerseSpend;
  /** Per-engine quota usage against the configured foundry limits. */
  quota: FrontierEngineUsage[];
  /** False when this server was started without --allow-dispatch: all POSTs 404. */
  dispatchEnabled: boolean;
}

// ---------------------------------------------------------------------------
// Safety (GET /api/verse/safety)
// ---------------------------------------------------------------------------

/** GET /api/verse/safety — the `ashlr verify-safety --json` report, unmodified. */
export type VerseSafetyReport = SafetyReport;

// ---------------------------------------------------------------------------
// Bounds (single source of truth — the API validator and the UI share these)
// ---------------------------------------------------------------------------

export const VERSE_CAPS_BOUNDS = {
  dailyBudgetUsd: { min: 0, max: 1_000 },
  perTickItems: { min: 1, max: 50 },
  parallel: { min: 1, max: 16 },
  intervalMs: { min: 30_000, max: 86_400_000 },
  maxConcurrent: { min: 1, max: 32 },
  /**
   * DELIBERATE DEVIATION from VERSE-CONTRACT-V2's "concurrency 0-32 each".
   *
   * The daemon cannot honour a zero tier. `resolveCfg` (daemon/loop.ts) only
   * adopts a tier when it is `> 0`, and `TieredPool`'s constructor floors
   * every cap at `Math.max(1, …)` on top of that — so a stored 0 came back as
   * the built-in 2/6/8 while the cockpit displayed 0. Teaching the pool to
   * accept 0 is not a fix either: `tieredBounded` would then never start a
   * task on that tier and never resolve, i.e. a hung tick.
   *
   * A floor of 1 is therefore the only value that is true in both places. To
   * stop dispatch entirely, the honest lever is `dailyBudgetUsd: 0`, which the
   * daemon now really does obey.
   */
  concurrency: { min: 1, max: 32 },
  subscriptionMaxPercent: { min: 1, max: 100 },
  foundryLimitMax: { min: 0, max: 1_000_000 },
} as const;

/** Hard ceiling on GET /api/verse/audit `limit`. */
export const VERSE_AUDIT_MAX_LIMIT = 500;
/** Default `limit` when the query omits one. */
export const VERSE_AUDIT_DEFAULT_LIMIT = 100;
/**
 * Hard ceiling on how many raw audit entries a single request will read before
 * filtering. Bounds the work a filtered query can ask of the disk.
 */
export const VERSE_AUDIT_MAX_SCAN = 5_000;

/** The kill switch's blast-radius warning — one string, used everywhere. */
export const VERSE_KILL_SWITCH_NOTE =
  'Emergency stop: the global kill switch also refuses the agent\'s own write tools, not just the daemon. Use the daemon pause action for an ordinary, reversible halt.';

/**
 * The pause's blast-radius statement — the counterpart to
 * VERSE_KILL_SWITCH_NOTE, shipped with every pause projection so no surface
 * can show the state without the scope. Says what it does NOT do, because
 * that is the entire difference from the control next to it.
 */
export const VERSE_DAEMON_PAUSE_NOTE =
  'Pause: halts autonomous dispatch only. Your own write tools keep working, nothing in flight is rolled back, and Resume restores the loop without a restart.';
