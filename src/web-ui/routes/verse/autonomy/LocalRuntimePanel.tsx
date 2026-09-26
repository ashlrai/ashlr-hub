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
import { useCallback, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { getQuerySnapshot, subscribeQuery } from '../../../data/cache.js';
import { StatusBadge, type Tone } from '../../../components/primitives/StatusBadge.js';
import { Meter } from '../../../components/primitives/Meter.js';
import { ConfirmDialog } from '../../inbox/ConfirmDialog.js';
import { formatContextWindow } from '../verse-model.js';
import { asClause, asSentence, tidyProse, UNKNOWN } from './format.js';
import type {
  FleetSnapshot,
  OptionalFleetRead,
  RuntimeAction,
  ServingRuntimeSnapshot,
} from './fleet-contract.js';
import {
  CONCURRENCY_EVIDENCE,
  formatUptime,
  runtimeCapacity,
  runtimeLabel,
  slotUtilisation,
  type RuntimeCapacity,
} from './fleet-model.js';
import { runRuntimeAction, VERSE_FLEET_KEY } from './fleet-queries.js';
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
  /**
   * The fleet read, for the lane-cap line. Omitted = the panel peeks the
   * app-wide `/api/verse/fleet` cache entry (see `useCachedFleetRead`).
   */
  fleet?: OptionalFleetRead<FleetSnapshot> | null;
}

// ---------------------------------------------------------------------------
// The lane cap (V3.10, B-U6)
// ---------------------------------------------------------------------------
//
// WHY THIS PANEL SAYS IT. The big number above is what the RUNTIME can run in
// parallel. Since 3.10 the fleet may run FEWER than that on a given tick: the
// tick's `laneCaps.local` (Mason present → 2, a Leader lane decision, the
// budget, the grant) lowers `deriveLocalFleetConcurrency`'s answer and names
// the limiter 'lane-cap'. Without a line here, "4 agents in parallel" next to
// a fleet running two reads as a slow or wedged fleet — the exact confusion
// the effective-vs-configured headline exists to prevent.
//
// The wire carries it only as a sentence: `projectFleetSnapshot`
// (core/daemon/local-fleet.ts) pushes LANE_CAP_NOTE_PREFIX + the limiter's
// reason into FleetSnapshot.notes; there is no structured limiter field on
// the route. The prefix is mirrored here and pinned against the real
// projector in fleet-panels.test.tsx, so a reworded note fails a test instead
// of silently hiding this line.

/** What `projectFleetSnapshot` prefixes a binding lane-cap note with. */
export const LANE_CAP_NOTE_PREFIX = "bounded by this tick's lane cap, not by slots: ";
/** `deriveLocalFleetConcurrency`'s reason when the cap is 0 (lane off). */
const LANE_OFF_RE = /^local lane is off this tick: (.+)$/s;
/** `deriveLocalFleetConcurrency`'s reason when the cap binds below the slots. */
const LANE_BELOW_RE = /^lane cap (\d+) is below (\d+) \([^)]*\): (.+)$/s;

export interface LaneCapView {
  /** true = no local agent this tick (cap 0). */
  off: boolean;
  /** The cap in force; null when the lane is off or the number is not stated. */
  limit: number | null;
  /** The concurrency the runtime would otherwise have allowed; null when not stated. */
  uncapped: number | null;
  /** Why — the tick's own sentence (presence, Leader, budget, grant). */
  why: string;
}

/** The binding lane cap from the fleet's notes, or null when no lane cap binds. */
export function laneCapFromNotes(notes: readonly string[] | null | undefined): LaneCapView | null {
  const note = notes?.find((n) => typeof n === 'string' && n.startsWith(LANE_CAP_NOTE_PREFIX));
  if (!note) return null;
  const reason = note.slice(LANE_CAP_NOTE_PREFIX.length).trim();
  const off = LANE_OFF_RE.exec(reason);
  // `why` is embedded mid-sentence ("…this tick: <why>."), so it is carried as
  // a clause: no closing period of its own, instants read as local time.
  if (off) return { off: true, limit: null, uncapped: null, why: asClause(tidyProse(off[1]!)) };
  const below = LANE_BELOW_RE.exec(reason);
  if (below) {
    return { off: false, limit: Number(below[1]), uncapped: Number(below[2]), why: asClause(tidyProse(below[3]!)) };
  }
  // A reason in a shape this client does not know: still say a lane cap binds,
  // in the server's words, rather than dropping the fact.
  return { off: false, limit: null, uncapped: null, why: asClause(tidyProse(reason)) };
}

/**
 * The fleet read as the app-wide cache holds it — WITHOUT fetching. The Fleet
 * tab's Advanced view already reads and polls `/api/verse/fleet` for the
 * FleetPanel beside this one; a second subscriber that fetched would only add
 * requests, and one mounted elsewhere (a test, a future surface) must not
 * start polling a route on its own.
 */
function useCachedFleetRead(): OptionalFleetRead<FleetSnapshot> | null {
  const entry = useSyncExternalStore(
    useCallback((listener: () => void) => subscribeQuery(VERSE_FLEET_KEY, listener), []),
    () => getQuerySnapshot<OptionalFleetRead<FleetSnapshot>>(VERSE_FLEET_KEY),
    () => getQuerySnapshot<OptionalFleetRead<FleetSnapshot>>(VERSE_FLEET_KEY),
  );
  return entry.data ?? null;
}

export function LocalRuntimePanel({
  read,
  guard,
  dispatchEnabled,
  loading = false,
  fleet: fleetProp,
}: LocalRuntimePanelProps): ReactNode {
  const now = useNow(1000);
  const cachedFleet = useCachedFleetRead();
  const fleet = fleetProp === undefined ? cachedFleet : fleetProp;
  const laneCap = laneCapFromNotes(fleet?.value?.notes);
  // The daemon writes the snapshot when it ticks; an aged one is last tick's cap, not this one's.
  const laneCapStale = fleet?.value?.notes.some((n) => n.startsWith('snapshot is ')) ?? false;
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
        setNote(result.note ? tidyProse(result.note) : null);
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
            'Serving runtime unavailable.'}
        </p>
      ) : runtime === null ? (
        <p className={styles.empty}>
          <span className={styles.emptyStrong}>Unreadable reading. </span>
          {read.reason ?? 'Unrecognized response — update Ashlr.'}
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
              <code className={styles.evidenceCode}>{tidyProse(runtime.reason)}</code>
            ) : null}
          </div>

          <div className={styles.facts}>
            <Fact label="Model" value={runtime.model ?? UNKNOWN} wide />
            <Fact label="Endpoint" value={runtime.endpoint ?? UNKNOWN} mono />
            <Fact label="Context" value={formatContextWindow(runtime.contextTokens)} />
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

            {laneCap ? (
              <p className={styles.capacityDetail} data-limiter="lane-cap" role="note">
                <StatusBadge status="lane-cap" tone={laneCap.off ? 'neutral' : 'warning'}>
                  {laneCap.off ? 'lane off' : 'lane-capped'}
                </StatusBadge>{' '}
                {laneCap.off
                  ? `The fleet runs no local agent ${laneCapStale ? 'as of its last tick' : 'this tick'}: ${asSentence(laneCap.why)}`
                  : `The fleet runs ${laneCap.limit === null ? 'fewer' : `at most ${laneCap.limit}`} local ${laneCap.limit === 1 ? 'agent' : 'agents'} ${laneCapStale ? 'as of its last tick' : 'this tick'}${laneCap.uncapped === null ? '' : `, not ${laneCap.uncapped}`} — a lane cap is tighter than this runtime: ${asSentence(laneCap.why)}`}
              </p>
            ) : null}

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
              Managed outside the hub (a login item or terminal owns it) — start and stop it there.
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
      {/* A mono or wide value can be cut with an ellipsis, so it carries itself in full as a tooltip. */}
      <span className={`${styles.factValue} ${mono ? styles.factMono : ''}`} title={mono || wide ? value : undefined}>
        {value}
      </span>
    </div>
  );
}
