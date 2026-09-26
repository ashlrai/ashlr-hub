/**
 * routes/verse/autonomy/FleetPanel.tsx — what the fleet is doing right now.
 *
 * The test this panel has to pass: a reader should be able to answer "is it
 * working, and on what" without opening a log. That means three things on
 * screen at once —
 *
 *   - a verdict in words at the top (`fleetPressure`), because "4 agents" is
 *     not an answer if three of them are queued;
 *   - slot occupancy against the EFFECTIVE concurrency, not the configured
 *     slot count, so a full runtime reads as full;
 *   - one row per agent with what it is working on and how long it has been
 *     at it, ticking, because a stuck agent is identified by its elapsed time
 *     and nothing else.
 *
 * The failure this panel exists to prevent: a queue that presents as slowness.
 * When turns are waiting, the panel says they are waiting, says they have not
 * started, and — on a runtime that serializes — says the queue drains one at a
 * time. Elapsed time for a queued turn is labelled as queued, never as work,
 * because those two numbers mean opposite things to whoever is deciding
 * whether something is wrong.
 */
import type { ReactNode } from 'react';
import { Meter } from '../../../components/primitives/Meter.js';
import { StatusBadge, type Tone } from '../../../components/primitives/StatusBadge.js';
import { UNKNOWN, formatCount, repoDisplayName, tidyProse } from './format.js';
import type { FleetAgent, FleetSnapshot, OptionalFleetRead } from './fleet-contract.js';
import {
  elapsedSince,
  fleetPressure,
  orderAgents,
  runtimeCapacity,
  slotUtilisation,
  type RuntimeCapacity,
} from './fleet-model.js';
import type { ServingRuntimeSnapshot } from './fleet-contract.js';
import { useNow } from './use-ticker.js';
import styles from './autonomy.module.css';

const PRESSURE_TONE: Record<string, Tone> = {
  idle: 'neutral',
  working: 'running',
  saturated: 'running',
  queued: 'warning',
  unknown: 'unknown',
};

const AGENT_TONE: Record<FleetAgent['state'], Tone> = {
  running: 'running',
  finishing: 'running',
  queued: 'neutral',
};

export interface FleetPanelProps {
  read: OptionalFleetRead<FleetSnapshot> | null;
  /** Needed for the EFFECTIVE concurrency; occupancy is meaningless without it. */
  runtime: ServingRuntimeSnapshot | null;
  loading?: boolean;
}

export function FleetPanel({ read, runtime, loading = false }: FleetPanelProps): ReactNode {
  const now = useNow(1000);
  const fleet = read?.value ?? null;
  const capacity = runtimeCapacity(runtime);

  // Slot figures come from the fleet snapshot when it has them and from the
  // runtime otherwise — one number, two possible reporters, never two numbers.
  const busy = fleet?.slotsBusy ?? runtime?.slotsBusy ?? null;
  const utilisation = slotUtilisation(busy, capacity.effectiveConcurrency);
  const pressure = fleetPressure(fleet, utilisation, capacity);
  const agents = fleet ? orderAgents(fleet.agents) : [];
  const queued = fleet?.queueDepth ?? agents.filter((a) => a.state === 'queued').length;

  return (
    <section className={styles.panel} aria-labelledby="verse-fleet-title">
      <div className={styles.panelHead}>
        <h3 id="verse-fleet-title" className={styles.panelTitle}>
          Fleet in flight
        </h3>
        <p className={styles.panelNote}>
          Every agent mid-turn right now, what it is working on, and how long it has been at it.
        </p>
      </div>

      {loading && read === null ? (
        <p className={styles.empty}>Reading the fleet…</p>
      ) : read === null || (!read.available && read.value === null) ? (
        <p className={styles.empty}>
          <span className={styles.emptyStrong}>Fleet status unavailable. </span>
          {read?.reason ?? null}
        </p>
      ) : fleet === null ? (
        <p className={styles.empty}>
          <span className={styles.emptyStrong}>Unreadable reading. </span>
          {read.reason ?? 'Unrecognized response — update Ashlr.'}
        </p>
      ) : (
        <>
          <div className={styles.pressure} data-state={pressure.state}>
            <span className={styles.pressureHead}>
              <span className={styles.pressureHeadline}>{pressure.headline}</span>
              <StatusBadge status={pressure.state} tone={PRESSURE_TONE[pressure.state] ?? 'unknown'}>
                {pressure.state}
              </StatusBadge>
            </span>
            <p className={styles.pressureDetail}>{pressure.detail}</p>
          </div>

          <div className={styles.fleetMeters}>
            <Meter
              value={utilisation.busy}
              max={utilisation.total}
              label="Slot utilisation"
              valueText={
                utilisation.percentText === null
                  ? 'unknown'
                  : `${utilisation.busy} / ${utilisation.total} · ${utilisation.percentText}`
              }
              tone={utilisation.saturated ? 'warning' : undefined}
            />
            <div className={styles.fact}>
              <span className={styles.factLabel}>Queue depth</span>
              <span
                className={styles.factValue}
                data-tone={queued > 0 ? 'warning' : undefined}
              >
                {fleet.queueDepth === null && agents.length === 0
                  ? UNKNOWN
                  : `${formatCount(queued)} waiting`}
              </span>
            </div>
          </div>

          {utilisation.saturated && queued === 0 ? (
            <p className={styles.capHelp}>
              Every slot is occupied. Nothing is waiting yet, but the next turn will.
            </p>
          ) : null}

          {agents.length === 0 ? (
            <p className={styles.empty}>
              <span className={styles.emptyStrong}>Nothing in flight. </span>
              No agent is mid-turn. The fleet answered and reported an empty list — an idle fleet,
              not a missing reading. Run one tick from Controls to put work in flight.
            </p>
          ) : (
            <div className={styles.tableScroll}>
              <table className={styles.table}>
                <caption className={styles.srOnly}>
                  Agents in flight: state, task, repository, model, slot and elapsed time
                </caption>
                <thead>
                  <tr>
                    <th scope="col">State</th>
                    <th scope="col">Working on</th>
                    <th scope="col">Repo</th>
                    <th scope="col">Model</th>
                    <th scope="col">Slot</th>
                    <th scope="col">Elapsed</th>
                  </tr>
                </thead>
                <tbody>
                  {agents.map((agent) => (
                    <AgentRow key={agent.id} agent={agent} now={now} capacity={capacity} />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {fleet.notes.length > 0 ? (
            <ul className={styles.noteList}>
              {fleet.notes.map((n) => (
                <li key={n} className={styles.capHelp}>
                  {tidyProse(n)}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </section>
  );
}

/**
 * One agent.
 *
 * The elapsed column is the reason this table exists, and it is the column
 * most easily made to lie: for a QUEUED turn the same number is time spent
 * waiting, not time spent working. Labelling it "queued" rather than letting
 * it sit under the same header as a running turn's duration is the difference
 * between "this one is stuck" and "this one has not started".
 */
function AgentRow({
  agent,
  now,
  capacity,
}: {
  agent: FleetAgent;
  now: number;
  capacity: RuntimeCapacity;
}): ReactNode {
  const elapsed = elapsedSince(agent.startedAt, now);
  const queued = agent.state === 'queued';
  return (
    <tr>
      <td>
        <StatusBadge status={agent.state} tone={AGENT_TONE[agent.state]}>
          {agent.state}
        </StatusBadge>
      </td>
      <td className={styles.cellSummary}>
        {agent.task ?? <span className={styles.capHelp}>not reported</span>}
      </td>
      {/* The enrolled checkout's folder name; the full path is the tooltip. */}
      <td className={styles.cellRepo} title={agent.repo ?? undefined}>
        {agent.repo ? repoDisplayName(agent.repo) : UNKNOWN}
      </td>
      <td className={styles.cellRepo}>{agent.model ?? agent.engine ?? UNKNOWN}</td>
      <td className={styles.cellTime}>
        {agent.slot === null ? (
          queued ? (
            <span
              className={styles.capHelp}
              title={
                capacity.verdict === 'serialized'
                  ? 'This runtime serializes, so only one slot ever frees up at a time.'
                  : undefined
              }
            >
              no slot
            </span>
          ) : (
            UNKNOWN
          )
        ) : (
          `#${agent.slot}`
        )}
      </td>
      <td className={styles.cellTime}>
        {elapsed}
        {queued ? <span className={styles.elapsedQualifier}> queued</span> : null}
      </td>
    </tr>
  );
}
