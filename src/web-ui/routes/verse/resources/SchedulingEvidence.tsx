import type { BudgetView } from '../../../../core/routing/policy.js';
import { lastSchedulingAdvice, schedulingEvidence, type SchedulingEvidenceView } from './scheduling-model.js';
import styles from './SchedulingEvidence.module.css';

export function SchedulingEvidence({ view }: { view: SchedulingEvidenceView }) {
  const summary = view.forecastSummary;
  const provenance = summary ? view.forecast.filter((line) => line !== summary.duration && line !== summary.fit) : [];
  return <div className={styles.evidence} data-scheduling={view.state}>
    <p className={styles.availability}>{view.availability}</p><p>{view.timing}</p>
    {view.opportunity ? <p>{view.opportunity}</p> : null}
    <p className={styles.freshness}>{view.freshness}</p>
    <div className={styles.forecast}>
      {summary ? <>
        <p className={styles.forecastLabel}>{summary.recorded}</p>
        {summary.duration ? <p>{summary.duration}</p> : <p>Task duration estimate unavailable.</p>}
        {summary.fit ? <p>{summary.fit}</p> : null}
        <p className={styles.freshness}>Historical estimates, not a completion guarantee.</p>
        <details className={styles.provenance}>
          <summary tabIndex={0}>Model, tokens &amp; evidence</summary>
          <div className={styles.provenanceBody}>{provenance.map((line) => <p key={line}>{line}</p>)}</div>
        </details>
      </> : view.forecast.map((line) => <p key={line}>{line}</p>)}
    </div>
  </div>;
}
/** Same shared budget snapshot as Resources; no additional query or provider probe. */
export function FleetScheduling({ budget, now }: { budget: BudgetView | null; now: number }) {
  const advice = lastSchedulingAdvice(budget, now);
  return <details className={styles.disclosure}>
    <summary tabIndex={0}>Capacity for work</summary>
    <div className={styles.body}>
      <p className={styles.intro}>Advisory timing and recorded task estimates. Existing permissions and account limits still apply.</p>
      {advice ? <p className={styles.intro}>{advice}</p> : null}
      {!budget || budget.seatInfo.length === 0 ? <p>Account scheduling evidence unavailable.</p>
        : <div className={styles.grid}>{budget.seatInfo.map((seat) => <section className={styles.card} key={seat.seatId} aria-label={`Work capacity: ${seat.label}`}>
          <h4>{seat.label}</h4><SchedulingEvidence view={schedulingEvidence(budget, seat, now)} />
        </section>)}</div>}
    </div>
  </details>;
}
