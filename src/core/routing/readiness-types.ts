/**
 * Per-resource readiness — the wire contract for `GET /api/verse/budget/readiness`
 * (3.14, "every account ready for chat and the fleet").
 *
 * One row per resource Mason can spend — each paid account, the local
 * runtimes as ONE resource, and the Claude cloud lane — answering the two
 * questions the Resources drawer (⌘.) exists for:
 *
 *   Chat   can a NEW chat run on it right now (the session engine's own
 *          admission gate, core/verse/seat-readiness.ts)?
 *   Fleet  would the AUTONOMOUS fleet use it right now — under the installed
 *          standing grant, its current rollout stage, the budget mode, the
 *          Leader's directives and the capacity snapshot the daemon routes on
 *          (~/.ashlr/routing/capacity.json)?
 *
 * Every "not ready" carries one plain sentence and, when one exists, the ONE
 * fix: a Verse action (reconnect / check again) or a literal command to run.
 * A command is never a secret and never names a private path beyond `~`.
 *
 * BROWSER-SAFE: type-only imports and constants. The web bundle imports it.
 */

export const VERSE_RESOURCE_READINESS_PATH = '/api/verse/budget/readiness';

export type ReadinessFixKind = 'reconnect' | 'check-again' | 'command';

export interface ReadinessFix {
  kind: ReadinessFixKind;
  /** Button / chip label: "Reconnect", "Check again", "Set up the Claude seat". */
  label: string;
  /** `command` only: the exact line to run in a terminal. */
  command?: string;
  /** `reconnect` / `check-again` only: the seat the action targets. */
  seatId?: string;
}

/** `ok` ready · `warn` usable with a caveat · `off` intentionally not used · `blocked` needs a fix. */
export type ReadinessTone = 'ok' | 'warn' | 'off' | 'blocked';

export interface ReadinessVerdict {
  ready: boolean;
  tone: ReadinessTone;
  /** Two or three words: "Ready", "Signed out", "Not in this stage". */
  word: string;
  /** One plain sentence (may be empty when `word` says it all). */
  detail: string;
  fix: ReadinessFix | null;
}

export interface FleetReadinessVerdict extends ReadinessVerdict {
  /** The grant's roles for this seat ("producer", "judge", "leader"); empty when not granted. */
  roles: string[];
  /** Percent of the binding window kept for Mason; null when not applicable (local, cloud, not granted). */
  reservePercent: number | null;
}

export interface ResourceReading {
  /** `live` = a current reading · `last` = only an expired one (see `at`) · `none` = never read here. */
  state: 'live' | 'last' | 'none';
  /** ISO instant of the reading (current or last); null when none. */
  at: string | null;
  /** Plain sentence on WHY there is no live reading; null when live. */
  note: string | null;
}

export interface ResourceReadinessRow {
  /** Account id (codex-personal, claude, …), `local`, or `cloud`. */
  id: string;
  label: string;
  /** 3.15: `devin` for the Devin card (built from core/devin's own verdicts). */
  engine: 'claude' | 'codex' | 'grok' | 'local' | 'devin';
  kind: 'subscription' | 'local' | 'cloud';
  reading: ResourceReading;
  chat: ReadinessVerdict;
  fleet: FleetReadinessVerdict;
}

export interface ResourceReadinessResponse {
  v: 1;
  checkedAt: string;
  /** Standing autonomy as the fleet sees it. */
  autonomy: {
    active: boolean;
    /** Current rollout stage id ("shadow"), when a grant is active. */
    stage: string | null;
    /** "Stage 1 of 8 · shadow" or why autonomy is off. */
    detail: string;
  };
  /** When the fleet's capacity snapshot was published; null when there is none. */
  capacitySnapshotAt: string | null;
  resources: ResourceReadinessRow[];
}
