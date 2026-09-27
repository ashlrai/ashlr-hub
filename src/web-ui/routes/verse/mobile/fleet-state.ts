/**
 * routes/verse/mobile/fleet-state.ts — the fleet in one word and one button,
 * for a phone (Home's top card and the Fleet screen's header). Pure.
 *
 * Four words, from three reads the workbench already makes:
 *
 *   control   GET /api/verse/control   daemon, the narrow pause, the kill switch
 *   live      GET /api/verse/fleet/live the fleet's own state and reason
 *   badge     GET /api/verse/activity   the autonomy switch (off/propose/autonomous)
 *
 *   Stopped   the kill switch is engaged, or no daemon is running
 *   Paused    the daemon-scoped pause is set
 *   Blocked   the daemon runs but nothing may move: no standing grant, the
 *             switch is off, the grant is paused ("Fleet dark")
 *   Running   the daemon runs under a grant (building, or idle between tasks)
 *
 * THE ONE BUTTON only ever does what is safe to do from a pocket:
 *   Running → Pause (narrow, instant to undo — no confirmation)
 *   Paused  → Resume (confirmed: work and spend start again)
 *   Stopped, no kill switch → Start (confirmed: starts an autonomous agent)
 *   Stopped BY the kill switch → no button. Releasing an emergency stop stays
 *   on the Mac (`ashlr fleet resume`); the phone can engage one, never undo it.
 *   Blocked → "See why" (opens Fleet; a grant is signed on the Mac).
 */
import type { FleetLiveSnapshotV1 } from '../../../../core/fleet/fleet-types.js';
import type { VerseControlSnapshot } from '../../../../core/verse/control-types.js';
import type { VerseAutonomyBadge } from '../../../../core/verse/workbench-types.js';

export type FleetHeadline = 'running' | 'paused' | 'stopped' | 'blocked' | 'unknown';

export const HEADLINE_LABEL: Readonly<Record<FleetHeadline, string>> = {
  running: 'Running',
  paused: 'Paused',
  stopped: 'Stopped',
  blocked: 'Blocked',
  unknown: 'Unknown',
};

export type DaemonVerb = 'start' | 'stop' | 'pause' | 'resume';

export interface ConfirmText {
  title: string;
  body: string;
  confirmLabel: string;
}

export type FleetPrimaryAction =
  | {
      kind: 'daemon';
      verb: DaemonVerb;
      label: string;
      /** Null = runs without a confirmation sheet (Pause). */
      confirm: ConfirmText | null;
      destructive: boolean;
    }
  | { kind: 'open-fleet'; label: string };

export interface FleetStateView {
  headline: FleetHeadline;
  label: string;
  /** One sentence: why it is in this state, or what it is doing. */
  detail: string;
  /** Runs building right now; null = unknown. */
  building: number | null;
  action: FleetPrimaryAction | null;
  /** The kill switch is engaged (only the Mac can release it). */
  killEngaged: boolean;
}

export interface FleetStateInput {
  control: VerseControlSnapshot | null;
  live: FleetLiveSnapshotV1 | null;
  badge: VerseAutonomyBadge | null;
}

export const DAEMON_CONFIRM: Readonly<Record<Exclude<DaemonVerb, 'pause'>, ConfirmText>> = {
  start: {
    title: 'Start the fleet?',
    body: 'Starts the autonomous daemon on your Mac. It picks up work in your enrolled repos and spends from your seats under the current budget mode.',
    confirmLabel: 'Start fleet',
  },
  resume: {
    title: 'Resume the fleet?',
    body: 'The daemon starts dispatching again: queued work runs and spends from your seats under the current budget mode.',
    confirmLabel: 'Resume',
  },
  stop: {
    title: 'Stop the fleet?',
    body: 'Stops the daemon by engaging the kill switch. Runs in flight are cut off and the agents’ own write tools refuse too. Only your Mac can release it (`ashlr fleet resume`).',
    confirmLabel: 'Stop fleet',
  },
};

export const PAUSE_ACTION: FleetPrimaryAction = { kind: 'daemon', verb: 'pause', label: 'Pause', confirm: null, destructive: false };
const RESUME_ACTION: FleetPrimaryAction = { kind: 'daemon', verb: 'resume', label: 'Resume', confirm: DAEMON_CONFIRM.resume, destructive: false };
const START_ACTION: FleetPrimaryAction = { kind: 'daemon', verb: 'start', label: 'Start', confirm: DAEMON_CONFIRM.start, destructive: false };
export const STOP_ACTION: FleetPrimaryAction = { kind: 'daemon', verb: 'stop', label: 'Stop', confirm: DAEMON_CONFIRM.stop, destructive: true };

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function fleetStateView({ control, live, badge }: FleetStateInput): FleetStateView {
  const building = live?.summary.building ?? null;
  const killEngaged = control?.killSwitch.state === 'active' || badge?.stopped === true;

  if (killEngaged) {
    return {
      headline: 'stopped',
      label: HEADLINE_LABEL.stopped,
      detail: control?.killSwitch.reason || 'The kill switch is engaged. Release it on your Mac with `ashlr fleet resume`.',
      building,
      action: { kind: 'open-fleet', label: 'Details' },
      killEngaged: true,
    };
  }
  if (control?.pause.state === 'paused' || live?.state === 'paused') {
    return {
      headline: 'paused',
      label: HEADLINE_LABEL.paused,
      detail: control?.pause.reason || live?.stateReason || 'Dispatch is paused. Nothing new starts until you resume.',
      building,
      action: RESUME_ACTION,
      killEngaged: false,
    };
  }
  if (control?.daemon.running === false || live?.state === 'stopped') {
    return {
      headline: 'stopped',
      label: HEADLINE_LABEL.stopped,
      detail: live?.stateReason || 'The fleet daemon is not running on your Mac.',
      building,
      action: START_ACTION,
      killEngaged: false,
    };
  }
  if (live?.state === 'dark' || badge?.mode === 'off' || badge?.paused === true) {
    return {
      headline: 'blocked',
      label: HEADLINE_LABEL.blocked,
      detail: live?.stateReason || badge?.label || 'No standing grant is in force, so the fleet cannot land work.',
      building,
      action: { kind: 'open-fleet', label: 'See why' },
      killEngaged: false,
    };
  }
  if (live?.state === 'running' || live?.state === 'idle' || control?.daemon.running === true) {
    const detail = building && building > 0
      ? `${plural(building, 'run', 'runs')} building${live?.summary.queued ? ` · ${live.summary.queued} queued` : ''}`
      : live?.stateReason || 'Idle between tasks.';
    return { headline: 'running', label: HEADLINE_LABEL.running, detail, building, action: PAUSE_ACTION, killEngaged: false };
  }
  return {
    headline: 'unknown',
    label: HEADLINE_LABEL.unknown,
    detail: 'Your Mac has not reported the fleet yet.',
    building,
    action: null,
    killEngaged: false,
  };
}

/** Whether the Fleet screen may offer Stop: never twice, never when nothing runs. */
export function canStop(view: FleetStateView): boolean {
  return !view.killEngaged && (view.headline === 'running' || view.headline === 'paused' || view.headline === 'blocked');
}
