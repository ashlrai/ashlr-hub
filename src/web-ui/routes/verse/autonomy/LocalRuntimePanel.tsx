/**
 * routes/verse/autonomy/LocalRuntimePanel.tsx — the serving runtime, which is
 * the thing that makes a local fleet possible at all.
 *
 * Read order, top to bottom, because that is the order the questions arrive:
 * is it up, what is it serving, how many agents can it actually run at once,
 * how full is it, and how do I start or stop it.
 *
 * The third question is the one this panel is really for. A runtime's
 * CONFIGURED slot count and its EFFECTIVE concurrency are different numbers
 * whenever the runtime refuses to batch, and printing the configured one is
 * how four agents become a four-deep queue that reads as slowness. So the big
 * number on this panel is `capacity.effectiveConcurrency` — never
 * `slotsTotal` — and when they disagree the panel says which is which and
 * shows the measurement behind the claim (docs/LOCAL-FLEET.md).
 *
 * State is never carried by colour alone: every tone is paired with a word
 * (StatusBadge) and a sentence.
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import { StatusBadge, type Tone } from '../../../components/primitives/StatusBadge.js';
import { Meter } from '../../../components/primitives/Meter.js';
import { ConfirmDialog } from '../../inbox/ConfirmDialog.js';
import { UNKNOWN } from './format.js';
import type {
  OptionalFleetRead,
  RuntimeAction,
  ServingRuntimeSnapshot,
} from './fleet-contract.js';
import {
  CONCURRENCY_EVIDENCE,
  formatContextTokens,
  formatUptime,
  runtimeCapacity,
  runtimeLabel,
  slotUtilisation,
  type RuntimeCapacity,
} from './fleet-model.js';
import { runRuntimeAction } from './fleet-queries.js';
import { useNow } from './use-ticker.js';
import type { GuardedAction } from './use-guarded-action.js';
import styles from './autonomy.module.css';

const STATE_TONE: Record<ServingRuntimeSnapshot['state'], Tone> = {
  running: 'success',
  starting: 'running',
  stopping: 'running',
  stopped: 'neutral',
  unknown: 'unknown',
};

const CAPACITY_TONE: Record<RuntimeCapacity['tone'], Tone> = {
  success: 'success',
  warning: 'warning',
  danger: 'danger',
  neutral: 'neutral',
  unknown: 'unknown',
};

export interface LocalRuntimePanelProps {
  read: OptionalFleetRead<ServingRuntimeSnapshot> | null;
  guard: GuardedAction;
  dispatchEnabled: boolean;
  /** Shown while the read is in flight and nothing has arrived yet. */
  loading?: boolean;
}

export function LocalRuntimePanel({
  read,
  guard,
  dispatchEnabled,
  loading = false,
}: LocalRuntimePanelProps): ReactNode {
  const now = useNow(1000);
  const [confirmStop, setConfirmStop] = useState<RuntimeAction | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const runtime = read?.value ?? null;
  const capacity = runtimeCapacity(runtime);
  const utilisation = slotUtilisation(runtime?.slotsBusy ?? null, capacity.effectiveConcurrency);
  const locked = !dispatchEnabled || guard.readOnly;
  const supervised = runtime?.supervised ?? false;
  const disabled = locked || guard.busy || !supervised;
  const running = runtime?.state === 'running';

  const act = (action: RuntimeAction, reason: string): void => {
    guard.request(
      () => runRuntimeAction(action),
      reason,
      (result) => {
        setNote(result.note || null);
        setConfirmStop(null);
      },
    );
  };

  return (
    <section className={styles.panel} aria-labelledby="verse-runtime-title">
      <div className={styles.panelHead}>
        <h3 id="verse-runtime-title" className={styles.panelTitle}>
          Serving runtime
        </h3>
        <p className={styles.panelNote}>
          The process that answers local agent turns. Without it, a local fleet has nowhere to run.
        </p>
      </div>

      {loading && read === null ? (
        <p className={styles.empty}>Reading the serving runtime…</p>
      ) : read === null || (!read.available && read.value === null) ? (
        <p className={styles.empty}>
          <span className={styles.emptyStrong}>No serving-runtime source. </span>
          {read?.reason ??
            'Nothing answered for the serving runtime, so whether a local fleet can run cannot be stated here.'}
        </p>
      ) : runtime === null ? (
        <p className={styles.empty}>
          <span className={styles.emptyStrong}>Unreadable reading. </span>
          {read.reason ?? 'The serving-runtime reading could not be narrowed, so nothing is shown rather than guessed.'}
        </p>
      ) : (
        <>
          <div className={styles.runtimeTop}>
            <span className={styles.runtimeState} data-state={runtime.state}>
              <span className={styles.runDot} aria-hidden="true" />
              <span className={styles.runtimeStateText}>
                {runtimeLabel(runtime.kind)}
                {' · '}
                {runtime.state === 'unknown' ? 'state unknown' : runtime.state}
              </span>
            </span>
            <StatusBadge status={runtime.state} tone={STATE_TONE[runtime.state]}>
              {runtime.state === 'running' ? 'serving' : runtime.state}
            </StatusBadge>
            {runtime.reason ? (
              <code className={styles.evidenceCode}>{runtime.reason}</code>
            ) : null}
          </div>

          <div className={styles.facts}>
            <Fact label="Model" value={runtime.model ?? UNKNOWN} wide />
            <Fact label="Endpoint" value={runtime.endpoint ?? UNKNOWN} mono />
            <Fact label="Context" value={formatContextTokens(runtime.contextTokens)} />
            <Fact
              label="Slots configured"
              value={runtime.slotsTotal === null ? UNKNOWN : String(runtime.slotsTotal)}
            />
            <Fact
              label="Uptime"
              value={running ? formatUptime(runtime.startedAt, now) : 'not running'}
            />
          </div>

          {/* The headline number. Deliberately the EFFECTIVE concurrency, so a
              runtime that will not batch cannot advertise its slot count. */}
          <div className={styles.capacityBlock} data-verdict={capacity.verdict}>
            <div className={styles.capacityHead}>
              <span className={styles.capacityBig}>
                {capacity.effectiveConcurrency === null ? UNKNOWN : capacity.effectiveConcurrency}
              </span>
              <div className={styles.capacityWords}>
                <span className={styles.capacityHeadline}>
                  {capacity.headline}
                  <StatusBadge status={capacity.verdict} tone={CAPACITY_TONE[capacity.tone]}>
                    {capacity.verdict === 'batched'
                      ? 'batches'
                      : capacity.verdict === 'serialized'
                        ? 'serializes'
                        : capacity.verdict === 'offline'
                          ? 'not serving'
                          : 'unconfirmed'}
                  </StatusBadge>
                </span>
                <span className={styles.capacityDetail}>{capacity.detail}</span>
              </div>
            </div>

            {capacity.overstated ? (
              <ConcurrencyEvidence
                configured={capacity.configuredSlots}
                refusal={runtime.parallel.refusal}
              />
            ) : null}
          </div>

          <div className={styles.utilisation}>
            <Meter
              value={utilisation.busy}
              max={utilisation.total}
              label="Slots in use"
              valueText={
                utilisation.percent === null
                  ? 'unknown'
                  : `${utilisation.busy} / ${utilisation.total}`
              }
              tone={utilisation.saturated ? 'warning' : undefined}
            />
            <p className={styles.capHelp}>{utilisation.label}</p>
          </div>

          <div className={styles.controls}>
            <button
              type="button"
              className={`${styles.button} ${styles.buttonPrimary}`}
              disabled={disabled || running}
              onClick={() => act('start', 'Starting the serving runtime requires the dispatch token.')}
            >
              Start runtime
            </button>
            <button
              type="button"
              className={styles.button}
              disabled={disabled || !running}
              onClick={() => setConfirmStop('stop')}
            >
              Stop runtime
            </button>
            <button
              type="button"
              className={styles.button}
              disabled={disabled}
              onClick={() => setConfirmStop('restart')}
            >
              Restart runtime
            </button>
          </div>

          {!supervised ? (
            <p className={styles.actionNote} role="status">
              This runtime is managed outside the hub, so it cannot be started or stopped from here.
              Whoever launched it — a login item, a terminal — still owns it; these controls stay
              disabled rather than sending an action that cannot land.
            </p>
          ) : null}

          {note && !guard.error ? (
            <p className={styles.actionNote} role="status">
              {note}
            </p>
          ) : null}

          {guard.error && confirmStop === null ? (
            <p className={styles.capError} role="alert">
              {guard.error}
            </p>
          ) : null}

          <ConfirmDialog
            open={confirmStop === 'stop'}
            onClose={() => setConfirmStop(null)}
            title="Stop the serving runtime?"
            body={
              <>
                Every local agent turn in flight is answered by this process. Stopping it ends those
                turns — nothing in flight is rolled back, and no local seat can take a new turn until
                it is running again.
                <br />
                <br />
                This does not touch the autonomous loop, the kill switch, or your own write tools.
              </>
            }
            confirmLabel="Stop runtime"
            destructive
            busy={guard.busy}
            error={guard.error}
            onConfirm={() => act('stop', 'Stopping the serving runtime requires the dispatch token.')}
          />

          <ConfirmDialog
            open={confirmStop === 'restart'}
            onClose={() => setConfirmStop(null)}
            title="Restart the serving runtime?"
            body={
              <>
                The process is stopped and started again. Turns in flight end with it, and the first
                turn afterwards pays the model load — on a 27 GB model that is not instant.
                <br />
                <br />
                Restart is the way to pick up a changed slot count or context size, since both are
                fixed at launch.
              </>
            }
            confirmLabel="Restart runtime"
            destructive
            busy={guard.busy}
            error={guard.error}
            onConfirm={() =>
              act('restart', 'Restarting the serving runtime requires the dispatch token.')
            }
          />
        </>
      )}
    </section>
  );
}

/**
 * The measurement behind "this runtime will not honour that slot count".
 *
 * Shown only when the two numbers actually disagree, because an operator on a
 * runtime that batches does not need to be argued with. It is presented as
 * measured data with its per-request times, not as a claim: the stagger in one
 * row and the dead heat in the other are the whole argument.
 */
function ConcurrencyEvidence({
  configured,
  refusal,
}: {
  configured: number | null;
  refusal: string | null;
}): ReactNode {
  return (
    <div className={styles.evidence}>
      <p className={styles.evidenceLead}>
        {configured === null
          ? 'The configured slot count is not a concurrency on this runtime.'
          : `${configured} slots are configured, but this runtime will not run them in parallel. Measured on this machine, four concurrent requests to the same model:`}
      </p>
      {/* Four columns of numerals do not fit a 900px window beside the rest
          of the cockpit, so the table gets its own scroll container rather
          than forcing the page body to scroll sideways. */}
      <div className={styles.evidenceScroll}>
        <table className={styles.evidenceTable}>
          <caption className={styles.srOnly}>
            Four concurrent requests to the same Qwen3.8 model file, per-runtime completion times in
            seconds
          </caption>
          <thead>
            <tr>
              <th scope="col">Runtime</th>
              <th scope="col">Per request (s)</th>
              <th scope="col">Wall (s)</th>
              <th scope="col">Finished</th>
            </tr>
          </thead>
          <tbody>
            {CONCURRENCY_EVIDENCE.map((row) => (
              <tr key={row.runtime}>
                <th scope="row">{row.runtime}</th>
                <td className={styles.evidenceNums}>{row.perRequestSeconds.join(' · ')}</td>
                <td className={styles.evidenceNums}>{row.wallSeconds.toFixed(1)}</td>
                <td>{row.verdict}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {refusal ? (
        <p className={styles.capHelp}>
          The runtime&rsquo;s own words: <code className={styles.evidenceCode}>{refusal}</code>
        </p>
      ) : null}
    </div>
  );
}

function Fact({
  label,
  value,
  mono = false,
  wide = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  wide?: boolean;
}): ReactNode {
  return (
    <div className={`${styles.fact} ${wide ? styles.factWide : ''}`}>
      <span className={styles.factLabel}>{label}</span>
      <span className={`${styles.factValue} ${mono ? styles.factMono : ''}`}>{value}</span>
    </div>
  );
}
