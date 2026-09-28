/**
 * fleet-control-model.ts — PURE: the one sentence of truth about the fleet,
 * the one thing blocking it, and which controls apply (3.15, the Fleet
 * control surface). BROWSER-SAFE.
 *
 * The order of the checks is the order Mason has to fix things in: Stop
 * first (it overrides everything), then custody, the grant, the switch, the
 * pause, the daemon, today's budget. Exactly one blocker is ever named — the
 * first one — with exactly one button.
 */
import type {
  FleetControlAvailability,
  FleetControlGrantView,
  FleetControlStateKind,
  FleetControlStateV1,
  FleetDaemonServiceState,
  FleetLivenessState,
  FleetNextAction,
  FleetPlistState,
} from './fleet-control-types.js';

export interface FleetControlInputs {
  nowMs: number;
  grant: FleetControlGrantView;
  custody: { installed: boolean | null; keyInitialized: boolean | null; hubCheckout: string | null };
  /** A custody key is compiled into this build's trust roots. */
  trustRootsCompiled: boolean;
  kill: boolean;
  paused: boolean;
  pausedAt: string | null;
  liveness: { state: FleetLivenessState; pid: number | null; lastTickAt: string | null; reason: string };
  service: FleetDaemonServiceState;
  plist: FleetPlistState;
  working: number | null;
  spend: { todayUsd: number | null; capUsd: number | null };
}

export const FLEET_ACTIONS = Object.freeze({
  start: { kind: 'start', label: 'Start the fleet', command: null, native: false } as FleetNextAction,
  resume: { kind: 'resume', label: 'Resume', command: 'ashlr daemon resume', native: false } as FleetNextAction,
  grant: { kind: 'grant', label: 'Approve a grant with Touch ID', command: 'ashlr authority grant', native: false } as FleetNextAction,
  reapprove: { kind: 're-approve', label: 'Re-approve with Touch ID', command: 'ashlr authority re-approve', native: false } as FleetNextAction,
  residentStart: { kind: 'resident-start', label: 'Start the daemon', command: 'ashlr authority resident start', native: true } as FleetNextAction,
  residentRestart: { kind: 'resident-restart', label: 'Restart the daemon', command: 'ashlr authority resident stop && ashlr authority resident start', native: true } as FleetNextAction,
  installCustody: { kind: 'install-custody', label: 'Install the custody helper', command: 'sudo scripts/install-custody.sh', native: true } as FleetNextAction,
  setup: { kind: 'setup', label: 'Finish setup', command: 'ashlr authority setup', native: false } as FleetNextAction,
});

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function money(n: number | null): string {
  if (n === null) return '$—';
  return n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`;
}

/** The daemon provably runs (launchd says running, or the pid is alive). */
export function daemonRunning(inputs: Pick<FleetControlInputs, 'liveness' | 'service'>): boolean {
  return inputs.service === 'running' || inputs.liveness.state === 'alive';
}

export function budgetExhausted(spend: FleetControlInputs['spend']): boolean {
  return spend.todayUsd !== null && spend.capUsd !== null && spend.capUsd > 0 && spend.todayUsd >= spend.capUsd;
}

interface Verdict {
  state: FleetControlStateKind;
  headline: string;
  blocker: FleetControlStateV1['blocker'];
}

function blocked(reason: string, action: FleetNextAction): Verdict {
  return { state: 'blocked', headline: `Blocked · ${reason}`, blocker: { reason, action } };
}

/** PURE: state, headline and the single blocker. */
export function fleetControlVerdict(inputs: FleetControlInputs): Verdict {
  const g = inputs.grant;
  const working = inputs.working;
  const agents = working === null ? 'agents unknown' : working === 0 ? 'no agents working' : `${plural(working, 'agent')} working`;
  if (inputs.kill) {
    return {
      state: 'stopped',
      headline: working && working > 0 ? `Stopped · ${plural(working, 'agent')} still winding down` : 'Stopped · nothing runs until you press Start',
      blocker: null,
    };
  }
  if (inputs.custody.installed === false) {
    return blocked('the custody helper that signs grants is not installed', FLEET_ACTIONS.installCustody);
  }
  if (g.state === 'none' || g.state === 'revoked' || g.state === 'invalid') {
    if (!inputs.trustRootsCompiled || inputs.custody.keyInitialized === false) {
      return blocked('setup is not finished (signing key or trust root missing)', FLEET_ACTIONS.setup);
    }
    const why = g.state === 'none' ? 'no standing grant is in force' : g.state === 'revoked' ? 'the grant was revoked' : 'the installed grant is not valid';
    return blocked(why, FLEET_ACTIONS.grant);
  }
  if (g.state === 'expired') return blocked('the grant expired', FLEET_ACTIONS.reapprove);
  if (g.state === 'paused') return blocked(g.reason ? `the grant is paused — ${g.reason}` : 'the grant is paused until you re-approve it', FLEET_ACTIONS.reapprove);
  if (g.switch === 'off' || g.effectiveSwitch === 'off') {
    return { state: 'off', headline: 'Off · autonomy is switched off — Start turns it on', blocker: null };
  }
  if (inputs.paused) {
    return {
      state: 'paused',
      headline: working && working > 0 ? `Paused · ${plural(working, 'agent')} finishing, nothing new starts` : 'Paused · nothing new starts until you resume',
      blocker: null,
    };
  }
  if (!daemonRunning(inputs)) {
    return blocked('the fleet daemon is not running', FLEET_ACTIONS.residentStart);
  }
  if (budgetExhausted(inputs.spend)) {
    return blocked(`today's budget is spent (${money(inputs.spend.todayUsd)} of ${money(inputs.spend.capUsd)}) — it resets at midnight UTC`, {
      kind: 'wait',
      label: 'Waits for midnight UTC',
      command: null,
      native: false,
    });
  }
  const mode = g.effectiveSwitch === 'propose' ? 'Proposing' : 'Running';
  const stage = g.stageId ? ` · stage ${g.stageId}` : '';
  const drift = inputs.plist === 'drifted'
    ? { reason: 'the daemon runs an older plist than your config (budget or interval changed)', action: FLEET_ACTIONS.residentRestart }
    : null;
  if (working !== null && working > 0) return { state: 'running', headline: `${mode} · ${agents}${stage}`, blocker: drift };
  return { state: 'idle', headline: `${mode === 'Running' ? 'Idle' : 'Proposing'} · on, waiting for work${stage}`, blocker: drift };
}

/** PURE: which of Start / Pause / Resume / Stop apply, and what each will do. */
export function fleetControlAvailability(inputs: FleetControlInputs, verdict: Verdict): FleetControlStateV1['controls'] {
  const steps: string[] = [];
  if (inputs.kill) steps.push('clears Stop');
  if (inputs.paused) steps.push('resumes dispatch');
  if (inputs.grant.switch === 'off' && inputs.grant.state === 'active') steps.push('switches to Autonomous');
  if (!daemonRunning(inputs)) steps.push('starts the daemon');
  const hardBlock = verdict.state === 'blocked' && verdict.blocker !== null
    && (verdict.blocker.action.kind === 'install-custody' || verdict.blocker.action.kind === 'setup' || verdict.blocker.action.kind === 'wait');
  const grantBlock = verdict.state === 'blocked' && verdict.blocker !== null
    && (verdict.blocker.action.kind === 'grant' || verdict.blocker.action.kind === 're-approve');
  const start: FleetControlAvailability = hardBlock
    ? { enabled: false, hint: `Blocked: ${verdict.blocker!.reason}.` }
    : grantBlock
      ? { enabled: true, hint: 'Opens the Touch ID grant sheet first, then starts the fleet.' }
      : steps.length === 0
        ? { enabled: false, hint: 'Already running.' }
        : { enabled: true, hint: `Start ${steps.join(', then ')}.` };
  const pause: FleetControlAvailability = inputs.kill
    ? { enabled: false, hint: 'Stop is engaged — nothing is dispatching.' }
    : inputs.paused
      ? { enabled: false, hint: 'Already paused.' }
      : { enabled: true, hint: 'In-flight runs finish; nothing new is dispatched.' };
  const resume: FleetControlAvailability = inputs.paused
    ? { enabled: true, hint: 'Dispatch picks up on the next tick.' }
    : { enabled: false, hint: 'Not paused.' };
  const stop: FleetControlAvailability = inputs.kill
    ? { enabled: false, hint: 'Already stopped.' }
    : { enabled: true, hint: 'Halts every running agent now and starts nothing new. Filed proposals, the grant and the daemon stay.' };
  return { start, pause, resume, stop };
}

/** PURE: the whole state object from observations. */
export function buildFleetControlState(inputs: FleetControlInputs): FleetControlStateV1 {
  const verdict = fleetControlVerdict(inputs);
  return {
    v: 1,
    checkedAt: new Date(inputs.nowMs).toISOString(),
    state: verdict.state,
    headline: verdict.headline,
    blocker: verdict.blocker,
    agents: { working: inputs.working },
    grant: inputs.grant,
    spend: { todayUsd: inputs.spend.todayUsd, capUsd: inputs.spend.capUsd, exhausted: budgetExhausted(inputs.spend) },
    daemon: {
      liveness: inputs.liveness.state,
      pid: inputs.liveness.pid,
      lastTickAt: inputs.liveness.lastTickAt,
      service: inputs.service,
      plist: inputs.plist,
      reason: inputs.liveness.reason,
    },
    kill: inputs.kill,
    paused: inputs.paused,
    pausedAt: inputs.pausedAt,
    custody: { ...inputs.custody },
    controls: fleetControlAvailability(inputs, verdict),
  };
}

/** PURE: whole days until `expiresAt` (floor), null when unknown. */
export function daysLeft(expiresAt: string | null, nowMs: number): number | null {
  if (!expiresAt) return null;
  const t = Date.parse(expiresAt);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((t - nowMs) / 86_400_000));
}
