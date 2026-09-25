/**
 * Fleet history — wire contract for `GET /api/verse/fleet/history` (V3.10, unit A8).
 *
 * A read-only DAILY projection of what the fleet actually did, built from the
 * ledgers that already exist on disk (run store, proposal inbox, decisions
 * ledger) plus the persisted fleet-scorecard trend. It never grants authority
 * and never replays anything: it only counts.
 *
 * HONESTY RULES (same vocabulary as the scorecard and VERSE-TELEMETRY-V2):
 *   - `null` means UNKNOWN. A count is `null` when its source could not be
 *     read at all. It is never coerced to 0.
 *   - A source that simply does not exist yet (`state: 'missing'`, e.g. a
 *     fresh machine with no inbox) is a COMPLETE, genuinely empty read, so its
 *     counts are real zeros.
 *   - A source that was only PARTLY readable (`complete: false`, e.g. one run
 *     file over the size bound) still reports counts, but they are LOWER
 *     BOUNDS. The chart must show the source's `reasons` as a caveat.
 *   - `claimCheck` is always `null` with `state: 'not-recorded'`: the claim
 *     integrity check's verdicts are folded into daemon tick COUNTS and never
 *     persisted per proposal, so there is nothing honest to chart yet.
 *
 * BROWSER-SAFE: imported by the web bundle — type-only imports and plain
 * constants, no node: modules.
 */

/**
 * Structural copy of `ScorecardTrendPoint` (core/fleet/scorecard.ts). Copied,
 * not imported, so the web typecheck never pulls the node-only scorecard graph;
 * fleet-history.ts asserts at compile time that the two stay assignable.
 */
export interface FleetScorecardTrendPoint {
  ts: string;
  window: '7d' | '30d';
  merges: { realized: number | null; released: number | null };
  releasedState: 'commissioned' | 'uncommissioned';
  costPerMergedChangeUsd: number | null;
  proposalsFiled: number | null;
  rejectionLessonsWritten: number | null;
}

/** Query bounds for `?days=`. */
export const FLEET_HISTORY_MIN_DAYS = 7;
export const FLEET_HISTORY_MAX_DAYS = 365;
export const FLEET_HISTORY_DEFAULT_DAYS = 90;

/**
 * A fleet with no run started or proposal filed for this long has gone QUIET
 * (`FleetHistoryResponse.darkSince`); its charts say "No fleet runs or
 * proposals since <date>" instead of drawing an empty axis. That is NOT the
 * fleet being dark — see `FleetLiveSnapshotV1.darkSince`.
 */
export const FLEET_DARK_AFTER_MS = 48 * 60 * 60 * 1000;

/**
 * - `healthy`      — every selected record was read and validated.
 * - `degraded`     — some records (or the whole source) could not be read.
 * - `missing`      — the source does not exist; a complete, empty read.
 * - `not-recorded` — nothing on disk records this signal at all.
 */
export type FleetHistorySourceState = 'healthy' | 'degraded' | 'missing' | 'not-recorded';

export interface FleetHistorySource {
  state: FleetHistorySourceState;
  /** True only when every in-scope record was read and validated. */
  complete: boolean;
  /** Stable machine reasons, e.g. `oversized-file`, `invalid-file`, `io-error`, `file-limit`. */
  reasons: string[];
  /** Records (files or rows) that contributed to the counts. */
  recordsRead: number;
  /** Records skipped for one of `reasons`. */
  recordsSkipped: number;
  /** Newest timestamp seen in this source, any day (ISO), or null when none. */
  lastRecordAt: string | null;
}

export interface FleetHistoryRuns {
  /** Runs whose createdAt falls on this day. */
  started: number | null;
  done: number | null;
  failed: number | null;
  aborted: number | null;
  /** Still `running` on disk (includes stale runs — see swimlane `stale`). */
  unfinished: number | null;
}

export interface FleetHistoryProposals {
  /** Proposals whose createdAt falls on this day. */
  filed: number | null;
  /** Of those, how many carried a non-empty, non-partial diff. */
  withDiff: number | null;
}

export interface FleetHistoryJudged {
  /** `judged` decision rows on this day. */
  total: number | null;
  ship: number | null;
  review: number | null;
  noise: number | null;
  harmful: number | null;
  /** Parse/network/unrecognized judge outcomes — NOT considered judgments. */
  failed: number | null;
}

export interface FleetHistoryVerification {
  /** Verification results dated to this day (verifiedAt, else proposal createdAt). */
  passed: number | null;
  /** Failed with an explicit `code` category: the verifier found a real problem. */
  failedCode: number | null;
  /** Failed for infrastructure reasons (tool/timeout/infra/cancelled/invalid-command). */
  failedInfra: number | null;
  /** Failed with no recorded category (legacy) — unknown whether code or infra. */
  failedUnknown: number | null;
  /** Of all verification results that day, how many ran a `test` command. */
  withTests: number | null;
}

export interface FleetHistoryDay {
  /** YYYY-MM-DD in the requested timezone offset (UTC by default). */
  day: string;
  runs: FleetHistoryRuns;
  proposals: FleetHistoryProposals;
  judged: FleetHistoryJudged;
  verification: FleetHistoryVerification;
  /** Authenticated realized merges observed this day (scorecard definition). */
  merges: { realized: number | null };
  /** Always null until claim-integrity verdicts are persisted (see module doc). */
  claimCheck: { passed: null; flagged: null };
  /** Estimated run spend started this day (runs' own usage estimate), USD. */
  estCostUsd: number | null;
}

/**
 * Proposal-centric, CUMULATIVE funnel for proposals filed in the window: each
 * stage counts proposals that also cleared every earlier stage, so the stages
 * are true subsets and a conversion rate can never exceed 100%.
 */
export interface FleetHistoryFunnel {
  filed: number | null;
  verified: number | null;
  verificationPassed: number | null;
  judgedShip: number | null;
  merged: number | null;
}

export type FleetRunStatus = 'running' | 'done' | 'failed' | 'aborted';

export interface FleetSwimlaneItem {
  /** Run id (an opaque identifier, never goal text). */
  id: string;
  /**
   * Epoch ms. Numbers, not ISO strings, on purpose: every string in a public
   * payload goes through the secret scrubber, and hundreds of bars' worth of
   * timestamps were most of this route's serialization cost.
   */
  startMs: number;
  /** Epoch ms; null while still running. */
  endMs: number | null;
  status: FleetRunStatus;
  engine: string;
  /** `running` on disk but not updated for over 30 minutes — probably orphaned. */
  stale: boolean;
}

export interface FleetSwimlane {
  /** Repository basename (never an absolute path), or `engine:<id>` when unscoped. */
  id: string;
  label: string;
  items: FleetSwimlaneItem[];
}

export interface FleetHistoryTotals {
  runsStarted: number | null;
  proposalsFiled: number | null;
  judged: number | null;
  verificationPassed: number | null;
  mergesRealized: number | null;
  estCostUsd: number | null;
}

export type FleetScorecardSnapshotMode = 'worker' | 'inline' | 'disabled';

export interface FleetHistoryScorecard {
  /** Oldest first — ready to chart. */
  trend7d: FleetScorecardTrendPoint[];
  trend30d: FleetScorecardTrendPoint[];
  source: FleetHistorySource;
  snapshot: {
    /** How snapshots are produced in this process. */
    mode: FleetScorecardSnapshotMode;
    /** Last time this process asked for a snapshot (ISO), or null. */
    lastAttemptAt: string | null;
    /** Last time an attempt actually appended history (ISO), or null. */
    lastWroteAt: string | null;
  };
}

export interface FleetHistoryResponse {
  generatedAt: string;
  window: { from: string; to: string; days: number; tzOffsetMinutes: number };
  /** Exactly `window.days` entries, oldest first, including empty days. */
  days: FleetHistoryDay[];
  totals: FleetHistoryTotals;
  funnel: FleetHistoryFunnel;
  /** Runs started in the window, grouped by repo; newest lanes first, bounded. */
  swimlanes: FleetSwimlane[];
  /** True when swimlanes were cut to the item bound. */
  swimlanesTruncated: boolean;
  /** Newest run start/update or proposal filing (ISO), or null when there is none. */
  lastActivityAt: string | null;
  /**
   * Set when `lastActivityAt` is older than FLEET_DARK_AFTER_MS: the fleet has
   * PRODUCED nothing (no run started, no proposal filed) since then. Judge
   * re-runs of old proposals do not count as fleet activity.
   *
   * Despite the (wire-frozen) name this is "quiet since", a different fact
   * from the fleet being dark: a fleet can tick for weeks under a grant and
   * produce nothing. "Fleet dark since …" is `FleetLiveSnapshotV1.darkSince`
   * (verse/fleet-live-api.ts `fleetDarkSince`), and only that value may be
   * worded that way; this one reads "No fleet runs or proposals since …".
   */
  darkSince: string | null;
  sources: {
    runs: FleetHistorySource;
    proposals: FleetHistorySource;
    decisions: FleetHistorySource;
    claimCheck: FleetHistorySource;
  };
  scorecard: FleetHistoryScorecard;
}
