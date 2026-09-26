/**
 * routes/verse/fleet/FleetCards.tsx — the Fleet surface's cards (SPEC-310B §6,
 * SPEC-310C §5; unit C7): lanes, the live swimlane, the gate funnel with its
 * refusal reasons, "why this seat", the parked Gantt and Overnight.
 *
 * Every card takes an OptionalRead and draws the designed state for each way
 * a source can be missing (not landed, unrecognised, dark) — never empty axes.
 */
import type { FleetLaneState, FleetLiveSnapshotV1 } from '../../../../core/fleet/fleet-types.js';
import type { SeatDecision } from '../../../../core/routing/types.js';
import type { BudgetView } from '../../../../core/routing/policy.js';
import { BarStack } from '../../../components/charts/BarStack.js';
import type { ChartStatus } from '../../../components/charts/ChartFrame.js';
import { Funnel } from '../../../components/charts/Funnel.js';
import { Swimlane } from '../../../components/charts/Swimlane.js';
import { EngineMarker } from '../../../components/primitives/Tag.js';
import { formatRelative } from '../autonomy/format.js';
import type { OptionalFleetRead } from '../autonomy/fleet-contract.js';
import type { OvernightStatus } from '../autonomy/overnight-contract.js';
import { describeStopRule } from '../autonomy/overnight-model.js';
import { CloudLaneChip } from '../cloud/CloudLaneChip.js';
import { Card, CardNote, MicroLabel } from '../command/Surface.js';
import type { OptionalRead } from '../command/surface-data.js';
import { fleetDarkStatus } from './dark-since.js';
import { LANE_ENGINE, LANE_LABEL, funnelStages, laneChipText, laneNotes, laneReason, laneRows, latestDecision, parkedGantt, refusalStack, runTone } from './live-model.js';
import { asSentence, decisionSummary, describeEligibleAgain, eligibleAgain, heldBackText } from './why-seat-model.js';
import styles from './fleet.module.css';

const HOUR = 3_600_000;

/**
 * The shared "is there a fleet to draw at all" decision for every chart card.
 * Dark reads THE dark-since instant (`fleetDarkStatus`), as the viewer's local
 * day — the same day Command's verdict line names — and no day at all when
 * the server does not know one.
 */
export function fleetStatus(read: OptionalRead<FleetLiveSnapshotV1> | undefined, empty: string, hasData: boolean): ChartStatus {
  if (!read) return { kind: 'loading' };
  const live = read.value;
  if (!live) return { kind: 'unknown', reason: read.reason ?? 'the live fleet view did not answer.' };
  if (live.state === 'dark' && !hasData) return fleetDarkStatus(live);
  return hasData ? { kind: 'ready' } : { kind: 'empty', message: empty };
}

// ---------------------------------------------------------------------------
// Lanes strip + live swimlane
// ---------------------------------------------------------------------------

/** "Local · off" — the chip is the lane and its slots; its why is one line below the strip (and its title). */
function LaneChip({ lane }: { lane: FleetLaneState }) {
  const text = laneChipText(lane);
  return (
    <li className={styles.lane} data-off={lane.slots === 0 || undefined} title={laneReason(lane) ?? undefined}>
      <EngineMarker engine={LANE_ENGINE[lane.lane]} />
      <span className={styles.laneName}>{text.name}</span>
      <span className={styles.laneSep} aria-hidden="true">
        {' · '}
      </span>
      <span className={styles.laneSlots}>{text.slots}</span>
    </li>
  );
}

export function LanesStrip({ live }: { live: FleetLiveSnapshotV1 | null }) {
  if (!live || live.lanes.length === 0) return null;
  const notes = laneNotes(live.lanes);
  return (
    <div className={styles.laneStrip}>
      <ul className={styles.lanes} aria-label="Lanes: busy of slots">
        {live.lanes.map((l) => (
          <LaneChip key={l.lane} lane={l} />
        ))}
        <CloudLaneChip classes={{ lane: styles.lane, name: styles.laneName, sep: styles.laneSep, slots: styles.laneSlots }} />
      </ul>
      {notes.length > 0 ? (
        <ul className={styles.laneNotes} aria-label="Why lanes are limited">
          {notes.map((n) => (
            <li key={n.lanes.join(',')}>
              {n.all ? null : <span className={styles.laneNoteLanes}>{n.lanes.map((l) => LANE_LABEL[l]).join(', ')}: </span>}
              {asSentence(n.reason)}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function LiveSwimlane({ read, now, hours }: { read: OptionalRead<FleetLiveSnapshotV1> | undefined; now: number; hours: number }) {
  const live = read?.value ?? null;
  const from = now - hours * HOUR;
  const lanes = live ? laneRows(live.runs, from, now, { includeParked: false }) : [];
  return (
    <Swimlane
      title="Live fleet"
      description={`Lanes × slots, last ${hours} h · bars coloured by phase or outcome · outlines are queued`}
      status={fleetStatus(read, `Nothing ran in the last ${hours} hours.`, lanes.length > 0)}
      lanes={lanes}
      from={from}
      to={now}
      now={now}
      toneOf={runTone}
    />
  );
}

// ---------------------------------------------------------------------------
// Gate funnel + refusal reasons
// ---------------------------------------------------------------------------

export function GateFunnelCards({ read }: { read: OptionalRead<FleetLiveSnapshotV1> | undefined }) {
  const live = read?.value ?? null;
  const funnel = live?.funnel ?? null;
  const stages = funnelStages(funnel);
  const refusals = refusalStack(funnel);
  const window = funnel ? `${new Date(funnel.from).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${new Date(funnel.to).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : undefined;
  return (
    <div className={styles.stack}>
      <Funnel
        title="Gate funnel"
        description={window ? `Proposals through G0–G7, ${window}` : 'Proposals through the merge gates G0–G7'}
        status={fleetStatus(read, 'No proposal reached the gates in this window.', stages.length > 0)}
        stages={stages}
      />
      <BarStack
        title="Refusals by gate"
        description={refusals.total ? `${refusals.total} refusals · top reasons keep their colour` : 'Why proposals stopped'}
        status={fleetStatus(read, 'Nothing was refused in this window.', refusals.total > 0)}
        categories={refusals.categories}
        segments={refusals.segments}
        values={refusals.values}
        height={180}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Why this seat
// ---------------------------------------------------------------------------

function seatLabel(view: BudgetView | null, seatId: string): { label: string; engine: 'claude' | 'codex' | 'grok' | 'local' | null } {
  const info = view?.seatInfo.find((s) => s.seatId === seatId);
  return { label: info?.label ?? seatId, engine: info?.engine ?? null };
}

export function DecisionView({ decision, view, now }: { decision: SeatDecision; view: BudgetView | null; now?: number }) {
  const chosen = decision.seatId ? seatLabel(view, decision.seatId) : null;
  return (
    <div className={styles.decision}>
      <p className={styles.decisionLead}>
        {chosen ? (
          <>
            {chosen.engine ? <EngineMarker engine={chosen.engine} /> : null}
            <strong>{chosen.label}</strong>
          </>
        ) : (
          <strong>No seat</strong>
        )}
        <span className={styles.mode}>{decision.mode}</span>
      </p>
      <p className={styles.decisionWhy}>{decisionSummary(decision)}</p>
      {decision.candidates.length > 1 ? (
        <div>
          <MicroLabel>Then</MicroLabel>
          <ol className={styles.candidates}>
            {decision.candidates.slice(decision.seatId ? 1 : 0).map((id) => (
              <li key={id}>{seatLabel(view, id).label}</li>
            ))}
          </ol>
        </div>
      ) : null}
      {decision.exclusions.length ? (
        <div>
          <MicroLabel>Held back</MicroLabel>
          <ul className={styles.exclusions} aria-label="Held back seats">
            {decision.exclusions.map((x) => (
              <li key={x.seatId}>
                <span className={styles.excluded}>{seatLabel(view, x.seatId).label}</span>
                <span className={styles.excludedWhy}>{heldBackText(x)}</span>
                <span className={styles.excludedWhen}>eligible again: {describeEligibleAgain(eligibleAgain(x), now)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export function WhySeatCard({ read, preview, view, now }: { read: OptionalRead<FleetLiveSnapshotV1> | undefined; preview: SeatDecision | null; view: BudgetView | null; now?: number }) {
  const latest = latestDecision(read?.value ?? null);
  return (
    <Card
      title="Why this seat"
      caption={latest ? `Latest dispatch: ${latest.run.title} (${formatRelative(latest.run.phaseStartedAt ?? latest.run.startedAt)})` : preview ? 'The next medium autonomous task would go to…' : undefined}
    >
      {latest ? (
        <DecisionView decision={latest.decision} view={view} now={now} />
      ) : preview ? (
        <DecisionView decision={preview} view={view} now={now} />
      ) : (
        <CardNote tone="unknown">No routing decision yet. The router preview didn't answer.</CardNote>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Parked Gantt
// ---------------------------------------------------------------------------

export function ParkedCard({ read, now }: { read: OptionalRead<FleetLiveSnapshotV1> | undefined; now: number }) {
  const live = read?.value ?? null;
  const gantt = live ? parkedGantt(live.runs, now) : { lanes: [], from: now - HOUR, to: now + 2 * HOUR, unknownRelease: 0 };
  return (
    <Swimlane
      title="Parked"
      description="Waiting for a seat to free up — each bar ends when it should"
      caveat={gantt.unknownRelease ? `${gantt.unknownRelease} item${gantt.unknownRelease === 1 ? ' has' : 's have'} no known release time; ${gantt.unknownRelease === 1 ? 'it runs' : 'they run'} to the right edge.` : undefined}
      status={fleetStatus(read, 'Nothing is parked.', gantt.lanes.length > 0)}
      lanes={gantt.lanes}
      from={gantt.from}
      to={gantt.to}
      now={now}
      toneOf={runTone}
      formatTick={(ms) => new Date(ms).toLocaleString('en-US', { weekday: 'short', hour: 'numeric' })}
    />
  );
}

// ---------------------------------------------------------------------------
// Overnight
// ---------------------------------------------------------------------------

export function OvernightCard({ read, onOpenAdvanced, dark = false }: { read: OptionalFleetRead<OvernightStatus> | undefined; onOpenAdvanced: () => void; /** The fleet is dark: it has no "normal schedule" to run on. */ dark?: boolean }) {
  const status = read?.value ?? null;
  const run = status?.run ?? null;
  return (
    <Card
      title="Overnight"
      caption={status ? (status.armed ? 'Armed' : 'Not armed') : undefined}
      actions={
        <button type="button" className={styles.link} onClick={onOpenAdvanced}>
          Arm or stop in Advanced
        </button>
      }
    >
      {!read ? (
        <p className={styles.muted} aria-busy="true">Reading the overnight lane…</p>
      ) : !status ? (
        <CardNote tone="unknown">{read.reason ?? 'The overnight lane did not answer.'}</CardNote>
      ) : !status.armed && !run ? (
        <CardNote>{dark ? 'Nothing armed.' : 'Nothing armed. The fleet runs on its normal schedule.'}</CardNote>
      ) : (
        <div className={styles.overnight}>
          {run?.stopRule ? <p className={styles.overnightLead}>{describeStopRule(run.stopRule)}</p> : null}
          <dl className={styles.facts}>
            <div>
              <dt>Started</dt>
              <dd>{run?.startedAt ? formatRelative(run.startedAt) : '—'}</dd>
            </div>
            <div>
              <dt>Iterations</dt>
              <dd>{run?.iterationsDone ?? '—'}</dd>
            </div>
            <div>
              <dt>Merged</dt>
              <dd>{run ? run.merged.length : '—'}</dd>
            </div>
            <div>
              <dt>Discarded</dt>
              <dd>{run ? run.discarded.length : '—'}</dd>
            </div>
          </dl>
          {run?.activity ? <p className={styles.muted}>Now: {run.activity}</p> : null}
          {run && run.discarded.length ? (
            <ul className={styles.discarded} aria-label="Discarded work">
              {run.discarded.slice(0, 3).map((d) => (
                <li key={d.id}>
                  <span className={styles.discardTitle}>{d.title}</span>
                  <span className={styles.discardWhy}>{d.reason}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </Card>
  );
}
