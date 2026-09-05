import { StatusBadge, type Tone } from '../primitives/StatusBadge.js';
import type {
  ActiveValueBetSummary,
  AgentOsCockpitSnapshot,
  CapabilityLaneSummary,
  EvidenceState,
} from './types.js';
import styles from './AgentOsCockpit.module.css';

export const MAX_VISIBLE_VALUE_BETS = 3;

function evidenceTone(state: EvidenceState): Tone {
  if (state === 'complete') return 'success';
  if (state === 'pending') return 'running';
  if (state === 'incomplete') return 'warning';
  return 'unknown';
}

function capabilityTone(state: CapabilityLaneSummary['state']): Tone {
  if (state === 'ready') return 'success';
  if (state === 'tight') return 'warning';
  if (state === 'unavailable') return 'danger';
  return 'unknown';
}

function decisionTone(decision: ActiveValueBetSummary['decision']): Tone {
  if (decision === 'continue') return 'running';
  if (decision === 'observing') return 'info';
  return 'warning';
}

function outcomeTone(state: ActiveValueBetSummary['outcome']['state']): Tone {
  if (state === 'effective') return 'success';
  if (state === 'refuted') return 'danger';
  if (state === 'pending') return 'running';
  return 'unknown';
}

function CapabilityLane({ capability }: { capability: CapabilityLaneSummary }) {
  return (
    <li className={styles.capabilityLane}>
      <div className={styles.laneIdentity}>
        <span className={styles.laneName}>{capability.label}</span>
        <StatusBadge status={capability.state} tone={capabilityTone(capability.state)} />
      </div>
      <div
        className={styles.headroomTrack}
        role="img"
        aria-label={`${capability.label} headroom: ${capability.headroom}`}
      >
        <span className={`${styles.headroomFill} ${styles[capability.headroom]}`} />
      </div>
      <span className={styles.allocation}>{capability.allocationLabel}</span>
      <span className={styles.reset} data-urgency={capability.resetUrgency}>
        {capability.resetLabel}
      </span>
    </li>
  );
}

function ValueBet({ bet }: { bet: ActiveValueBetSummary }) {
  return (
    <li className={styles.bet}>
      <div className={styles.betDecision}>
        <StatusBadge status={bet.decision} tone={decisionTone(bet.decision)} />
        <span className={styles.assurance}>{bet.assurance}</span>
      </div>
      <div className={styles.betThesis}>
        <h3>{bet.title}</h3>
        <p>{bet.valueCase}</p>
      </div>
      <span className={styles.betAllocation}>{bet.allocationLabel}</span>
      <div className={styles.betEvidence}>
        <span>
          <span className={styles.fieldLabel}>Outcome</span>
          <StatusBadge status={bet.outcome.state} tone={outcomeTone(bet.outcome.state)}>
            {bet.outcome.label}
          </StatusBadge>
        </span>
        <span>
          <span className={styles.fieldLabel}>Evidence</span>
          <StatusBadge status={bet.evidence.state} tone={evidenceTone(bet.evidence.state)}>
            {bet.evidence.label}
          </StatusBadge>
        </span>
      </div>
    </li>
  );
}

export function AgentOsCockpit({ snapshot }: { snapshot: AgentOsCockpitSnapshot }) {
  const visibleBets = snapshot.activeValueBets.slice(0, MAX_VISIBLE_VALUE_BETS);
  const omittedBets = Math.max(0, snapshot.activeValueBets.length - visibleBets.length);
  const nextAction = snapshot.nextAction;

  return (
    <section className={styles.cockpit} aria-labelledby="agent-os-title">
      <header className={styles.decisionSpine}>
        <div className={styles.mission}>
          <div className={styles.titleLine}>
            <h2 id="agent-os-title">Agent OS</h2>
            <StatusBadge
              status={snapshot.sourceState}
              tone={snapshot.sourceState === 'healthy' ? 'success' : snapshot.sourceState === 'degraded' ? 'warning' : 'unknown'}
            />
            <span className={styles.revision}>{snapshot.livingEndState.revisionLabel}</span>
          </div>
          <p className={styles.northStar}>{snapshot.livingEndState.northStar}</p>
          <p className={styles.bottleneck}>
            <span>Current bottleneck</span>
            {snapshot.livingEndState.currentBottleneck}
          </p>
        </div>

        <aside
          className={`${styles.nextAction} ${nextAction ? styles[nextAction.kind] : styles.clear}`}
          aria-label="Exception-first next action"
        >
          <span className={styles.nextActionLabel}>Next action</span>
          <strong>{nextAction?.title ?? 'No verified next action available'}</strong>
          <p>{nextAction?.reason ?? 'No exception or clearance evidence was provided.'}</p>
          {nextAction ? (
            <StatusBadge status={nextAction.evidenceState} tone={evidenceTone(nextAction.evidenceState)}>
              {nextAction.evidenceState} evidence
            </StatusBadge>
          ) : null}
        </aside>
      </header>

      <section className={styles.spectrum} aria-labelledby="capability-spectrum-title">
        <div className={styles.sectionHeading}>
          <h3 id="capability-spectrum-title">Capability spectrum</h3>
          <p>Usable model runway, ordered by reset urgency</p>
        </div>
        {snapshot.capabilitySpectrum.length > 0 ? (
          <ul className={styles.capabilityList}>
            {snapshot.capabilitySpectrum.map((capability) => (
              <CapabilityLane key={capability.lane} capability={capability} />
            ))}
          </ul>
        ) : (
          <p className={styles.empty}>Capability evidence is not available.</p>
        )}
      </section>

      <section className={styles.bets} aria-labelledby="active-value-bets-title">
        <div className={styles.sectionHeading}>
          <h3 id="active-value-bets-title">Active value bets</h3>
          <p>{visibleBets.length} of 3 portfolio slots visible</p>
        </div>
        {visibleBets.length > 0 ? (
          <ol className={styles.betList}>
            {visibleBets.map((bet) => <ValueBet key={bet.key} bet={bet} />)}
          </ol>
        ) : (
          <p className={styles.empty}>No active value bet is verified.</p>
        )}
        {omittedBets > 0 ? (
          <p className={styles.omitted}>{omittedBets} lower-ranked {omittedBets === 1 ? 'bet is' : 'bets are'} held outside this view.</p>
        ) : null}
      </section>

      <p className={styles.authorityNote}>
        Observation only. This view cannot dispatch, merge, release, deploy, or change policy.
      </p>
    </section>
  );
}
