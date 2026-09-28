/**
 * fleet-control-types.ts — the Fleet control surface's wire contract (3.15).
 *
 * ONE place to operate the fleet: the Fleet tab's header says in one sentence
 * what the fleet is doing, shows the grant, today's spend, the daemon's
 * health and how many agents are working, and carries Start / Pause / Resume /
 * Stop. Every control is idempotent and every answer is RE-READ from disk
 * after the mutation (never optimistic).
 *
 *   GET  /api/verse/fleet/control              → FleetControlStateV1
 *   GET  /api/verse/fleet/control/runs/<id>/log → FleetRunLogV1
 *   GET  /api/verse/fleet/control/queue        → FleetControlQueueV1 (tasks + goals to edit)
 *   POST /api/verse/fleet/control              → one FleetControlAction → FleetControlActionResultV1
 *
 * BROWSER-SAFE: type-only imports and plain constants.
 */
import type { GrantState } from '../authority/types.js';

export const VERSE_FLEET_CONTROL_PATH = '/api/verse/fleet/control';
export const VERSE_FLEET_CONTROL_QUEUE_PATH = `${VERSE_FLEET_CONTROL_PATH}/queue`;
export const VERSE_FLEET_CONTROL_RUNS_PREFIX = `${VERSE_FLEET_CONTROL_PATH}/runs/`;

/**
 * - `running` — agents are working now.
 * - `idle`    — the fleet is on and healthy, nothing to do this minute.
 * - `paused`  — dispatch paused (in-flight runs finish; nothing new starts).
 * - `stopped` — Stop is engaged (every run was halted; nothing runs).
 * - `blocked` — something only Mason can fix stands in the way (`blocker`).
 * - `off`     — the switch is Off (autonomy was turned off on purpose).
 */
export type FleetControlStateKind = 'running' | 'idle' | 'paused' | 'stopped' | 'blocked' | 'off';

/**
 * The single next thing to do. `native` actions need the desktop app (they
 * run through its native confirm dialog); `command` is what the same thing is
 * in a terminal, for a browser session. `sheet` opens the Touch ID grant sheet.
 */
export type FleetNextActionKind =
  | 'start'
  | 'resume'
  | 'grant'
  | 're-approve'
  | 'resident-start'
  | 'resident-restart'
  | 'install-custody'
  | 'setup'
  | 'wait';

export interface FleetNextAction {
  kind: FleetNextActionKind;
  /** Button text, e.g. "Start the daemon". */
  label: string;
  /** The equivalent terminal command, or null when there is none (e.g. Touch ID sheet). */
  command: string | null;
  /** Runs through the desktop app's native layer (fleet_ops.rs). */
  native: boolean;
}

export interface FleetControlAvailability {
  enabled: boolean;
  /** Why it is disabled, or what pressing it will do. */
  hint: string;
}

export type FleetDaemonServiceState = 'running' | 'loaded' | 'not-loaded' | 'absent' | 'unknown';
export type FleetPlistState = 'current' | 'drifted' | 'absent' | 'unknown';
export type FleetLivenessState = 'alive' | 'stale' | 'stopped' | 'unknown';

export interface FleetControlGrantView {
  state: GrantState;
  seq: number | null;
  /** Granted repos (count) and their names. */
  repos: string[];
  engines: string[];
  expiresAt: string | null;
  /** Whole days left (floor); null without a grant. */
  daysLeft: number | null;
  stageId: string | null;
  stageIndex: number | null;
  stageCount: number | null;
  switch: 'off' | 'propose' | 'autonomous';
  effectiveSwitch: 'off' | 'propose' | 'autonomous';
  maxSwitchWithoutGrant: 'off' | 'propose' | 'autonomous';
  reason: string | null;
}

export interface FleetControlStateV1 {
  v: 1;
  checkedAt: string;
  state: FleetControlStateKind;
  /** ONE sentence of truth ("Running · 3 agents working"). */
  headline: string;
  /** Present when `state` is `blocked` (and for a daemon that needs a restart): one reason, one button. */
  blocker: { reason: string; action: FleetNextAction } | null;
  agents: {
    /** Live execution leases — agents actually running now. null = unknown. */
    working: number | null;
  };
  grant: FleetControlGrantView;
  spend: {
    todayUsd: number | null;
    capUsd: number | null;
    exhausted: boolean;
  };
  daemon: {
    liveness: FleetLivenessState;
    pid: number | null;
    lastTickAt: string | null;
    service: FleetDaemonServiceState;
    plist: FleetPlistState;
    /** One sentence. */
    reason: string;
  };
  kill: boolean;
  paused: boolean;
  pausedAt: string | null;
  custody: {
    installed: boolean | null;
    keyInitialized: boolean | null;
    /** An ashlr-hub checkout the helper can be (re)installed from; null = none enrolled. */
    hubCheckout: string | null;
  };
  controls: {
    start: FleetControlAvailability;
    pause: FleetControlAvailability;
    resume: FleetControlAvailability;
    stop: FleetControlAvailability;
  };
}

/** Exactly one per POST. */
export type FleetControlAction =
  | { action: 'start' }
  | { action: 'pause' }
  | { action: 'resume' }
  | { action: 'stop' }
  /** Stop ONE run (fleet/run-cancel.ts); its task, if any, goes back to the queue. */
  | { action: 'stop-run'; runId: string; reason?: string; taskId?: string }
  /**
   * Steer a run. Fleet engines run headless (no live input channel), so this
   * is always stop + requeue with the note appended to the task's brief —
   * `mode: 'stop-and-requeue'` in the answer says so.
   */
  | { action: 'interject'; note: string; runId?: string; taskId?: string; repo?: string; title?: string }
  | { action: 'task-edit'; taskId: string; value?: number; repo?: string }
  | { action: 'task-cancel'; taskId: string }
  | { action: 'goal-retarget'; goalId: string; project: string };

export interface FleetControlActionResultV1 {
  ok: true;
  action: FleetControlAction['action'];
  /** Plain sentences of what actually happened, in order (empty = nothing needed doing). */
  did: string[];
  /** What Mason still has to do for this action to finish (a native step, the grant sheet). */
  needs: FleetNextAction | null;
  /** `interject` only. */
  mode?: 'stop-and-requeue' | 'requeue';
  /** The state read back AFTER the action. */
  state: FleetControlStateV1;
}

export interface FleetRunLogV1 {
  v: 1;
  runId: string;
  /** false when run-output capture is off (foundry.runOutputPersistence.enabled) or the run kept none. */
  available: boolean;
  /** Why there is no log, when `available` is false. */
  reason: string | null;
  /** The last lines, oldest first (each ≤ 2 000 chars). */
  lines: { ts: string | null; kind: string; text: string }[];
  truncated: boolean;
  /** Stop was requested for this run (and when). */
  stopRequestedAt: string | null;
}

export interface FleetControlQueueV1 {
  v: 1;
  tasks: {
    id: string;
    repo: string;
    title: string;
    status: 'queued' | 'parked' | 'dispatched';
    value: number;
    source: string;
    updatedAt: string;
  }[];
  goals: {
    id: string;
    objective: string;
    status: string;
    /** Enrolled checkout path; null = repo-agnostic. */
    project: string | null;
    /** A mission-bound goal is signed; its repo is not edited here. */
    missionBound: boolean;
  }[];
  /** Enrolled checkouts a goal may target, and granted repos a task may target. */
  targets: { paths: string[]; repos: string[] };
  reason: string | null;
}
