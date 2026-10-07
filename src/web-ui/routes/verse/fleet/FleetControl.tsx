/**
 * routes/verse/fleet/FleetControl.tsx — the ONE place to operate the fleet
 * (3.15). The Fleet tab's header:
 *
 *   ● Running · 3 agents working · stage shadow      [Start ⌘⌥S] [Pause ⌘⌥P] [Stop ⌘⌥.]
 *   Blocked: <one reason>  [one button]
 *   Agents 3 working | Grant #2 · 14 repos · 28 d · shadow 1/8 [Edit] | Spend $1.20 of $20 | Daemon running · ticked 1 m ago [Restart]
 *
 * Every control posts to /api/verse/fleet/control and renders the state the
 * server READ BACK afterwards — never an optimistic flip. Start confirms
 * first; Stop confirms with the catalog's Stop copy; Pause and Resume are
 * instant. What only Mason can do comes back as the single next action:
 * the Touch ID grant sheet, or a native step in the desktop app (resident
 * daemon start / restart, custody install) behind a native confirm dialog.
 * In a browser without the desktop shell those show the Terminal command.
 *
 * ⌘K and the keys (command-keys.ts fleet.*) run the same handlers.
 */
import { formatMetricUsd } from '../../../components/charts/format-metric.js';
import { useRef, useState, type ReactNode } from 'react';
import type { FleetControlActionResultV1, FleetControlStateV1, FleetNextAction } from '../../../../core/fleet/fleet-control-types.js';
import { Button } from '../../../components/primitives/Button.js';
import { Input } from '../../../components/primitives/Input.js';
import { Meter } from '../../../components/primitives/Meter.js';
import { IconLock, IconPause, IconPlay, IconRefresh, IconStop } from '../../../components/primitives/icons.js';
import { useQuery, useRefetch, useRefresh } from '../../../data/hooks.js';
import { runQuery } from '../../../data/cache.js';
import { CopyCommand } from '../autonomy/AutonomyOffState.js';
import { formatRelative } from '../autonomy/format.js';
import { stopConfirm, type GrantFlow } from '../command/AutonomyBar.js';
import type { ConfirmSpec, SurfaceActions } from '../command/actions.js';
import { CardNote, MicroLabel } from '../command/Surface.js';
import { useCommandHandler } from '../shell/command-bus.js';
import { detectKeyPlatform, formatChord } from '../shell/command-catalog.js';
import { commandChord } from '../shell/command-keys.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { darkSinceLabel } from './dark-since.js';
import { fleetControlQuery, postFleetControl, refreshFleetControlReads } from './fleet-control-queries.js';
import { nativeFleetAvailable, runNativeFleetOp, type NativeFleetEvent, type NativeFleetOp } from './native-fleet.js';
import styles from './fleet-control.module.css';

export const FLEET_CONTROL_POLL_MS = 5_000;

const START_CONFIRM: ConfirmSpec = {
  title: 'Start the fleet?',
  body: 'Start clears Stop, resumes dispatch and, if autonomy is switched Off, turns it to Autonomous — only within your signed grant. If the daemon is not running, the desktop app asks you to confirm starting it.',
  confirmLabel: 'Start fleet',
  destructive: false,
};

const STATE_TONE: Record<FleetControlStateV1['state'], string> = {
  running: 'running',
  idle: 'ok',
  paused: 'warning',
  stopped: 'danger',
  blocked: 'danger',
  off: 'muted',
};

const STATE_WORD: Record<FleetControlStateV1['state'], string> = {
  running: 'Running',
  idle: 'Idle',
  paused: 'Paused',
  stopped: 'Stopped',
  blocked: 'Blocked',
  off: 'Off',
};

function keyHint(id: string): string | null {
  const chord = commandChord(id);
  return chord ? formatChord(chord, detectKeyPlatform()) : null;
}

function money(n: number | null): string {
  if (n === null) return '$—';
  return formatMetricUsd(n);
}

/** Syntax only; native validates the actual directory, origin and installer. */
function custodyCheckoutValid(value: string): boolean {
  const characters = [...value];
  return (value.startsWith('/') || value.startsWith('~/'))
    && characters.length <= 1024 && characters.every((character) => {
      const code = character.codePointAt(0)!;
      return code > 31 && code !== 127;
    });
}

/** The native op a next action maps to, if any. */
function nativeOpFor(action: FleetNextAction): NativeFleetOp | null {
  if (action.kind === 'resident-start') return 'resident-start';
  if (action.kind === 'resident-restart') return 'resident-restart';
  if (action.kind === 'install-custody') return 'custody-install';
  return null;
}

interface Progress {
  op: NativeFleetOp;
  event: NativeFleetEvent | null;
  /** The exact command native named (kept across events: the last may omit it). */
  command?: string;
}

export interface FleetControlProps {
  actions: SurfaceActions;
  grantFlow: GrantFlow;
  /** THE dark-since instant (fleet/dark-since.ts fleetDarkSince); null unless the fleet is dark. */
  darkSince?: string | null;
  /** The setup checklist is shown under the control (FleetSection): the blocker names no command. */
  setupShownBelow?: boolean;
}

export function FleetControl({ actions, grantFlow, darkSince = null, setupShownBelow = false }: FleetControlProps) {
  const read = useQuery(fleetControlQuery, { freshMs: 4_000 });
  const refetch = useRefetch(fleetControlQuery);
  const refresh = useRefresh(fleetControlQuery);
  // A slow/queued read must finish before the next automatic poll replaces it.
  // Native completion still forces a newer read through refreshFleetControlReads.
  usePollWhileVisible(() => {
    void runQuery(fleetControlQuery.key, () => fleetControlQuery.fetch());
  }, FLEET_CONTROL_POLL_MS);
  const [did, setDid] = useState<string[]>([]);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [needs, setNeeds] = useState<FleetNextAction | null>(null);
  const [checkoutOverride, setCheckoutOverride] = useState<string | null>(null);
  const nativePending = useRef(false);
  const state = read.data?.value ?? null;
  const checkout = (checkoutOverride ?? state?.custody.hubCheckout ?? '').trim();
  const checkoutValid = custodyCheckoutValid(checkout);
  const busy = actions.busy || (progress !== null && progress.event !== null ? !['done', 'failed', 'cancelled'].includes(progress.event.phase) : progress !== null);

  function afterAction(result: FleetControlActionResultV1): void {
    setDid(result.did);
    setNeeds(result.needs);
    refetch();
    if (result.needs) void take(result.needs, result.state);
  }

  function runNative(op: NativeFleetOp, checkout?: string): void {
    if ((op === 'custody-install' && (busy || nativePending.current)) || !nativeFleetAvailable(op)) return;
    if (op === 'custody-install') nativePending.current = true;
    setProgress({ op, event: null });
    const track = (event: NativeFleetEvent) => setProgress((prev) => ({ op, event, ...(event.command ?? prev?.command ? { command: event.command ?? prev?.command } : {}) }));
    void runNativeFleetOp(op, { ...(checkout ? { checkout } : {}), onProgress: track })
      .then((event) => {
        track(event);
        if (event.phase === 'done') setNeeds(null);
      })
      .catch((error: unknown) => setProgress({ op, event: { id: '', op, phase: 'failed', message: error instanceof Error ? error.message : String(error) } }))
      .finally(() => {
        if (op === 'custody-install') nativePending.current = false;
        // A failed/cancelled native operation can also have changed disk state;
        // read the shared projections rather than assuming its final state.
        refreshFleetControlReads();
      });
  }

  function installCustody(detected = state?.custody.hubCheckout): void {
    const selected = (checkoutOverride ?? detected ?? '').trim();
    if (custodyCheckoutValid(selected)) runNative('custody-install', selected);
  }

  /** Do the single next thing Mason was asked to do. */
  async function take(action: FleetNextAction, current: FleetControlStateV1 | null = state): Promise<void> {
    if (action.kind === 'grant' || action.kind === 're-approve') {
      grantFlow.open(action.kind, action.kind === 're-approve' ? 'The fleet needs the grant renewed before it can run.' : 'The fleet needs a standing grant before it can run.', 'autonomous');
      return;
    }
    if (action.kind === 'start') {
      start();
      return;
    }
    if (action.kind === 'resume') {
      resume();
      return;
    }
    const op = nativeOpFor(action);
    if (op && nativeFleetAvailable(op)) {
      if (op === 'custody-install') {
        // A just-read default is useful before the next render; an explicit
        // choice (including empty) must never fall back to another checkout.
        installCustody(current?.custody.hubCheckout);
      } else runNative(op);
    }
  }

  function start(): void {
    actions.act(() => postFleetControl({ action: 'start' }), 'Start the fleet', { confirm: START_CONFIRM, onDone: afterAction });
  }
  function pause(): void {
    actions.act(() => postFleetControl({ action: 'pause' }), 'Pause the fleet', { onDone: afterAction });
  }
  function resume(): void {
    actions.act(() => postFleetControl({ action: 'resume' }), 'Resume the fleet', { onDone: afterAction });
  }
  function stop(): void {
    actions.act(() => postFleetControl({ action: 'stop' }), 'Stop the fleet', { confirm: stopConfirm(), onDone: afterAction });
  }
  function restartDaemon(): void {
    runNative('resident-restart');
  }
  function stopDaemon(): void {
    // The desktop app asks in its own native dialog (lowering: no token).
    runNative('resident-stop');
  }
  function editGrant(): void {
    const active = state?.grant.state === 'active' || state?.grant.state === 'paused' || state?.grant.state === 'expired';
    grantFlow.open(active ? 're-approve' : 'grant', 'Choose what the fleet may do, check the difference, then sign it with Touch ID.', null, { edit: true });
  }

  const controls = state?.controls;
  useCommandHandler('fleet.start', () => {
    if (controls?.start.enabled ?? true) start();
  });
  useCommandHandler('fleet.pause', () => {
    if (controls?.pause.enabled) pause();
  });
  useCommandHandler('fleet.resume', () => {
    if (controls?.resume.enabled) resume();
  });
  useCommandHandler('fleet.halt', () => stop());
  useCommandHandler('fleet.restart-daemon', () => restartDaemon());
  useCommandHandler('fleet.edit-grant', () => editGrant());
  useCommandHandler('fleet.install-custody', () => {
    installCustody();
  });

  if (!state) {
    // The same region while it loads, so the page (and a screen reader) keeps its place.
    return (
      <section className={styles.control} aria-label="Fleet control" data-state="unknown">
        {read.status === 'loading' && !read.data ? (
          <p className={styles.muted} aria-busy="true">Reading the fleet…</p>
        ) : (
          <CardNote tone="unknown">{read.data?.reason ?? 'The fleet controls could not be read.'}</CardNote>
        )}
      </section>
    );
  }

  const blocker = state.blocker;
  const nativeCapable = nativeFleetAvailable();
  const g = state.grant;
  const stage = g.stageId ? `${g.stageId}${g.stageIndex !== null && g.stageCount ? ` (${g.stageIndex + 1}/${g.stageCount})` : ''}` : null;
  const tickProgress = state.daemon.liveness === 'alive' && state.daemon.pid !== null ? state.daemon.tickProgress : null;
  const preparing = state.state === 'running' && tickProgress != null && state.agents.working === 0;
  // The cache retains an error during a retry; only a successful read clears it.
  const lastKnown = read.error !== undefined;
  const custodyNeedsAttention = state.custody.installed !== true || state.custody.keyInitialized !== true
    || blocker?.action.kind === 'install-custody' || needs?.kind === 'install-custody'
    || progress?.op === 'custody-install';
  const daemonLine = state.daemon.service === 'running' || state.daemon.liveness === 'alive'
    ? `Running${state.daemon.pid ? ` · pid ${state.daemon.pid}` : ''}${tickProgress ? ` · ${tickProgress.summary}` : ''}${state.daemon.lastTickAt ? ` · ${tickProgress ? 'last completed' : 'ticked'} ${formatRelative(state.daemon.lastTickAt)}` : ''}`
    : state.daemon.service === 'absent' ? 'Not installed'
      : state.daemon.service === 'unknown' && state.daemon.liveness === 'unknown' ? 'Status unavailable'
        : state.daemon.liveness === 'stale' ? 'Not responding' : 'Not running';

  return (
    <section className={styles.control} aria-label="Fleet control" data-state={lastKnown ? 'unknown' : state.state} aria-busy={read.status === 'refreshing'}>
      <div className={styles.head}>
        <p className={styles.headline} role="status" aria-live="polite">
          <span className={styles.dot} data-tone={lastKnown ? 'muted' : STATE_TONE[state.state]} aria-hidden="true" />
          <span className={styles.stateWord}>{lastKnown ? 'Last known:' : ''} {preparing ? 'Preparing work' : STATE_WORD[state.state]}</span>
          <span>{preparing ? `0 agents working · ${tickProgress.phase}${stage ? ` · stage ${stage}` : ''}` : state.headline.replace(/^[A-Z][a-z]+ · /u, '')}</span>
        </p>
        <div className={styles.buttons} role="group" aria-label="Fleet controls">
          {state.paused ? (
            <ControlButton label="Resume" icon={<IconPlay />} keyId="fleet.resume" availability={state.controls.resume} onClick={resume} busy={actions.busy} readOnly={actions.readOnly} />
          ) : (
            <ControlButton label="Start" icon={<IconPlay />} keyId="fleet.start" availability={state.controls.start} onClick={start} busy={actions.busy} readOnly={actions.readOnly} primary />
          )}
          {state.paused ? null : (
            <ControlButton label="Pause" icon={<IconPause />} keyId="fleet.pause" availability={state.controls.pause} onClick={pause} busy={actions.busy} readOnly={actions.readOnly} />
          )}
          <ControlButton label="Stop" icon={<IconStop />} keyId="fleet.halt" availability={state.controls.stop} onClick={stop} busy={actions.busy} readOnly={actions.readOnly} danger />
        </div>
      </div>

      {read.status === 'refreshing' || lastKnown ? (
        <p className={styles.muted} role="status">
          {lastKnown ? `The latest fleet status could not be read. Showing the last reading from ${formatRelative(state.checkedAt)}.` : 'Updating fleet status…'}
          <button type="button" className={styles.link} onClick={refresh}>Check again</button>
        </p>
      ) : null}

      {darkSince && state.state !== 'running' && state.state !== 'idle' ? (
        <p className={styles.muted}>Fleet dark since {darkSinceLabel(darkSince)}</p>
      ) : null}

      {blocker ? (
        <BlockerRow
          reason={blocker.reason}
          action={blocker.action}
          nativeCapable={nativeCapable}
          hubCheckout={checkoutValid ? checkout : null}
          busy={busy}
          onTake={() => void take(blocker.action)}
          setupShownBelow={setupShownBelow}
        />
      ) : needs && needs.kind !== 'grant' && needs.kind !== 're-approve' ? (
        <BlockerRow reason="one step left" action={needs} nativeCapable={nativeCapable} hubCheckout={checkoutValid ? checkout : null} busy={busy} onTake={() => void take(needs)} />
      ) : null}

      {did.length > 0 ? (
        <p className={styles.did} role="status">
          {did.join(' ')}
          <button type="button" className={styles.link} onClick={() => setDid([])}>
            Dismiss
          </button>
        </p>
      ) : null}

      {progress ? <NativeProgress progress={progress} onDismiss={() => setProgress(null)} /> : null}

      <dl className={styles.facts}>
        <div className={styles.fact}>
          <dt><MicroLabel>Agents</MicroLabel></dt>
          <dd className={styles.factValue}>{state.agents.working === null ? 'unknown' : state.agents.working === 0 ? 'none working' : `${state.agents.working} working`}</dd>
        </div>
        <div className={styles.fact}>
          <dt><MicroLabel>Grant</MicroLabel></dt>
          <dd className={styles.factValue}>
            {g.state === 'active'
              ? `#${g.seq ?? '?'} · ${g.repos.length} repo${g.repos.length === 1 ? '' : 's'} · ${g.daysLeft ?? '?'} d left${stage ? ` · ${stage}` : ''}`
              : g.state === 'none' ? 'none signed' : g.state}
            <span className={styles.factSub}>{g.engines.length ? g.engines.join(', ') : 'no engines'} · switch {g.effectiveSwitch}</span>
            <button type="button" className={styles.link} onClick={editGrant} disabled={actions.readOnly}>
              <IconLock width={12} height={12} aria-hidden="true" /> Edit scope
            </button>
          </dd>
        </div>
        <div className={styles.fact}>
          <dt><MicroLabel>Spend today</MicroLabel></dt>
          <dd className={styles.factValue}>
            <Meter
              value={state.spend.todayUsd}
              max={state.spend.capUsd}
              variant="line"
              aria-label="Spend today against the daily cap"
              valueText={`${money(state.spend.todayUsd)} of ${money(state.spend.capUsd)}`}
            />
            <span className={styles.factSub}>{money(state.spend.todayUsd)} of {money(state.spend.capUsd)} cap{state.spend.exhausted ? ' · spent' : ''}</span>
          </dd>
        </div>
        <div className={styles.fact}>
          <dt><MicroLabel>Daemon</MicroLabel></dt>
          <dd className={styles.factValue}>
            {daemonLine}
            {state.daemon.plist === 'drifted' ? <span className={styles.factSub}>plist is older than your config</span> : null}
            {nativeCapable ? (
              <span className={styles.inlineButtons}>
                {state.daemon.service === 'running' || state.daemon.liveness === 'alive' ? (
                  <>
                    <Button size="sm" variant="ghost" icon={<IconRefresh />} onClick={restartDaemon} disabled={busy}>
                      Restart
                    </Button>
                    <Button size="sm" variant="ghost" onClick={stopDaemon} disabled={busy}>
                      Stop daemon
                    </Button>
                  </>
                ) : null}
              </span>
            ) : null}
          </dd>
        </div>
        <div className={styles.fact}>
          <dt><MicroLabel>Custody</MicroLabel></dt>
          <dd className={styles.factValue}>
            {state.custody.installed === true
              ? `Installed${state.custody.keyInitialized === true ? ' · key ready' : state.custody.keyInitialized === false ? ' · no key yet' : ''}`
              : state.custody.installed === false ? 'Not installed' : 'unknown'}
            <details className={styles.output} open={custodyNeedsAttention}>
              <summary>Helper settings</summary>
              <span className={styles.factSub}>Signs grants with Touch ID; holds the GitHub App key</span>
              {nativeCapable ? (
                <>
                  <Input label="Custody source checkout" size="sm" mono
                    value={checkoutOverride ?? state.custody.hubCheckout ?? ''}
                    onChange={(event) => setCheckoutOverride(event.target.value)}
                    disabled={busy} autoComplete="off" spellCheck={false}
                    placeholder="/absolute/path/to/ashlr-hub"
                    hint="Choose the trusted Hub source to build. Native checks the checkout and confirms its installer hash and command; administrator approval is required."
                    error={checkoutOverride !== null && !checkoutValid ? 'Enter an absolute path or ~/path within the native 1024-character limit.' : undefined} />
                  <span className={styles.inlineButtons}>
                    <Button size="sm" variant="ghost" onClick={() => installCustody()} disabled={busy || !checkoutValid}>
                      {state.custody.installed === true ? 'Reinstall / upgrade' : 'Install'}
                    </Button>
                  </span>
                </>
              ) : null}
            </details>
          </dd>
        </div>
      </dl>
    </section>
  );
}

function ControlButton({
  label,
  icon,
  keyId,
  availability,
  onClick,
  busy,
  readOnly,
  primary,
  danger,
}: {
  label: string;
  icon: ReactNode;
  keyId: string;
  availability: { enabled: boolean; hint: string };
  onClick: () => void;
  busy: boolean;
  readOnly: boolean;
  primary?: boolean;
  danger?: boolean;
}) {
  const key = keyHint(keyId);
  const disabled = !availability.enabled || readOnly;
  return (
    <Button
      size="sm"
      variant={danger ? 'danger' : primary && availability.enabled ? 'primary' : 'subtle'}
      icon={icon}
      onClick={onClick}
      disabled={disabled}
      busy={busy && !disabled}
      title={readOnly ? 'Read-only session' : `${availability.hint}${key ? ` (${key})` : ''}`}
      aria-keyshortcuts={key ?? undefined}
    >
      {label}
      {key ? <kbd className={styles.kbd}>{key}</kbd> : null}
    </Button>
  );
}

function BlockerRow({
  reason,
  action,
  nativeCapable,
  hubCheckout,
  busy,
  onTake,
  setupShownBelow = false,
}: {
  reason: string;
  action: FleetNextAction;
  nativeCapable: boolean;
  hubCheckout: string | null;
  busy: boolean;
  onTake: () => void;
  setupShownBelow?: boolean;
}) {
  const op = nativeOpFor(action);
  const needsNative = op !== null;
  const canNative = needsNative && nativeCapable && (op !== 'custody-install' || hubCheckout !== null);
  const clickable = action.kind !== 'wait' && action.kind !== 'setup' && (!needsNative || canNative);
  const command = action.kind === 'install-custody' && hubCheckout ? `cd ${hubCheckout} && ${action.command}` : action.command;
  return (
    <div className={styles.blocker} role="alert">
      <p className={styles.blockerReason}>
        <strong>{reason.charAt(0).toUpperCase()}{reason.slice(1)}.</strong>
      </p>
      {clickable ? (
        <Button size="sm" variant="primary" onClick={onTake} busy={busy}>
          {action.label}
        </Button>
      ) : null}
      {action.kind === 'setup' && setupShownBelow ? (
        <span className={styles.muted}>The setup checklist below names each remaining step.</span>
      ) : !clickable && command ? (
        <span className={styles.blockerCommand}>
          <span className={styles.muted}>
            {needsNative && !nativeCapable ? 'Open the Phantom desktop app to do this with a click, or run:' : action.kind === 'setup' ? 'Finish the remaining setup steps (GitHub App, trust root, Claude token):' : 'Run:'}
          </span>
          <CopyCommand command={command} />
        </span>
      ) : null}
      {action.kind === 'install-custody' && nativeCapable && !hubCheckout ? (
        <span className={styles.muted}>Enroll your ashlr-hub checkout first — the helper is built from its tools/custody sources.</span>
      ) : null}
    </div>
  );
}

const PHASE_WORD: Record<NativeFleetEvent['phase'], string> = {
  confirming: 'Waiting for you in the dialog',
  running: 'Running',
  done: 'Done',
  failed: 'Did not finish',
  cancelled: 'Cancelled',
};

function NativeProgress({ progress, onDismiss }: { progress: Progress; onDismiss: () => void }) {
  const event = progress.event;
  const terminal = event !== null && (event.phase === 'done' || event.phase === 'failed' || event.phase === 'cancelled');
  return (
    <div className={styles.progress} data-phase={event?.phase ?? 'confirming'} role="status" aria-live="polite">
      <p className={styles.progressLine}>
        <strong>{event ? PHASE_WORD[event.phase] : 'Asking the desktop app…'}</strong>
        {event ? ` — ${event.message}` : ''}
        {terminal ? (
          <button type="button" className={styles.link} onClick={onDismiss}>
            Dismiss
          </button>
        ) : null}
      </p>
      {progress.command ? <code className={styles.command}>{progress.command}</code> : null}
      {event?.output ? (
        <details className={styles.output} open={event.phase === 'failed'}>
          <summary>Output{event.exitCode !== undefined ? ` (exit ${event.exitCode})` : ''}</summary>
          <pre>{event.output}</pre>
        </details>
      ) : null}
    </div>
  );
}
