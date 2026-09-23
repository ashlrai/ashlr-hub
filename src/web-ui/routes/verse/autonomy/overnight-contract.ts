/**
 * routes/verse/autonomy/overnight-contract.ts — the shapes the Overnight
 * panel is typed against, declared HERE on purpose.
 *
 * `GET/POST /api/verse/overnight` does not exist yet: the engine, the permit,
 * the budget lane and the local-only policy are being built in parallel by
 * four other owners. This module is the client's written-down half of that
 * contract, in exactly the position `fleet-contract.ts` occupied while
 * `/api/verse/{runtime,fleet,local-only}` were still being written. When the
 * route lands, this file becomes a re-export seam pointing at whatever
 * `src/core/verse/*` declares — the same move `control-types.ts` and
 * `fleet-contract.ts` have already made — and nothing in the panel changes.
 *
 * Three commitments the shapes make, because getting them wrong is how a
 * cockpit ends up stating something false about an unattended run:
 *
 *  1. **Every observation is nullable.** `null` means "not observed", never
 *     zero. A run with `iterationsDone: null` has not reported a count; a run
 *     with `iterationsDone: 0` has, and the answer is none. `format.ts`'s rule
 *     ("absent is not zero") is the whole reason the counters are typed this
 *     way rather than defaulted at the edge.
 *  2. **The stop rule is a discriminated union, not a triple of optional
 *     fields.** There is exactly one rule per run; a shape that could carry a
 *     stop time AND an iteration cap would be a shape the UI has to guess at.
 *  3. **Nothing here carries a secret.** Repo NAMES and paths only, no
 *     tokens, no launcher commands, no remote URLs with credentials
 *     (VERSE-CONTRACT-V2, "Ground rules").
 */

/** Which of the three stop rules a run was armed with. */
export type OvernightStopRuleKind = 'until-paused' | 'at-time' | 'after-iterations';

/** Runs until a human pauses it. No clock, no counter. */
export interface OvernightStopUntilPaused {
  kind: 'until-paused';
}

/** Stops at a wall-clock instant, carried as an absolute ISO-8601 timestamp. */
export interface OvernightStopAtTime {
  kind: 'at-time';
  /**
   * ISO-8601 with an offset. Deliberately NOT "07:00": the operator picks a
   * wall-clock time, the client resolves it to the next occurrence of that
   * time in the operator's own zone, and the absolute instant is what crosses
   * the wire — so a run armed at 23:50 for 07:00 cannot be read by the server
   * as ten minutes ago.
   */
  at: string;
}

/** Stops after a fixed number of loop iterations. */
export interface OvernightStopAfterIterations {
  kind: 'after-iterations';
  iterations: number;
}

export type OvernightStopRule =
  | OvernightStopUntilPaused
  | OvernightStopAtTime
  | OvernightStopAfterIterations;

/**
 * The gate a change has to pass before it is merged.
 *
 * Every field is tri-state. `true` = this check runs and blocks, `false` =
 * it does not run, `null` = the server did not say. The panel renders the
 * third case as "not stated", never as "off" — an unreported gate is not an
 * absent gate, and the difference decides whether a person should arm this.
 */
export interface OvernightGate {
  tests: boolean | null;
  lint: boolean | null;
  typecheck: boolean | null;
  /** True when a change that passes the gate is merged with no human step. */
  autoMerge: boolean | null;
  /** The branch a passing change lands on, e.g. `master`. */
  branch: string | null;
}

/** One change the run merged. */
export interface OvernightMerge {
  id: string;
  repo: string;
  title: string;
  /** ISO-8601. */
  at: string | null;
  /** Short SHA, when the server sends one. */
  commit: string | null;
}

/** One change the run threw away, and the gate that refused it. */
export interface OvernightDiscard {
  id: string;
  repo: string;
  title: string;
  at: string | null;
  /** The server's own sentence: "tests failed", "typecheck: 3 errors". */
  reason: string;
}

/** The run in flight. */
export interface OvernightRun {
  runId: string;
  /** ISO-8601 — the "how long has it been running" clock. */
  startedAt: string | null;
  stopRule: OvernightStopRule | null;
  /** Iterations completed so far. `null` = not reported. */
  iterationsDone: number | null;
  /** The enrolled repo it is working in right now. */
  repo: string | null;
  /** What it is doing right now, in the server's own words. */
  activity: string | null;
  merged: OvernightMerge[];
  discarded: OvernightDiscard[];
}

/** `GET /api/verse/overnight`. */
export interface OvernightStatus {
  armed: boolean;
  /** Null when nothing is armed, or when an armed run has not reported yet. */
  run: OvernightRun | null;
  /** How many enrolled repos the run works through. `null` = not reported. */
  repos: number | null;
  gate: OvernightGate | null;
}

/** `POST /api/verse/overnight` — the two things the panel can ask for. */
export type OvernightAction =
  | { action: 'arm'; stopRule: OvernightStopRule }
  | { action: 'disarm' };

/**
 * The receipt. `note` is the server's own sentence about what just happened
 * and is rendered verbatim, the way `VerseDaemonActionResult.note` already is
 * in DaemonControls — a refusal the server bothered to write is always better
 * copy than anything this client could guess.
 */
export interface OvernightActionResult {
  ok: boolean;
  note: string | null;
  /** The post-action status, when the server sends it. Saves a round trip. */
  status: OvernightStatus | null;
}
