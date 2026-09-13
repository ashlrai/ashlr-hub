import type { ResourceEngineeringCampaignOutcome } from '../../../core/resources/engineering-outcomes-types.js';
import { engineeringPhaseReasons } from '../../data/workspace-engineering-phase-evidence.js';
import styles from './EngineeringOutcomes.module.css';

type Evidence = NonNullable<ResourceEngineeringCampaignOutcome['phaseEvidence']>;
const seedLabel = { unmeasured: 'Seed not measured', 'intent-recorded': 'Seed evaluation intent recorded', 'result-recorded': 'Seed result recorded' };
const evaluatorLabel = { 'intent-recorded': 'Evaluation intent recorded; settlement pending', 'not-started': 'Evaluator did not start', 'group-exit-confirmed': 'Evaluator process group settled' };
const workerLabel = { 'not-recorded': 'No worker receipt recorded', unverified: 'Worker receipt unverified', reserved: 'Worker reservation recorded',
  completed: 'Worker completion recorded', failed: 'Worker failure recorded', 'timed-out': 'Worker timeout recorded', cancelled: 'Worker cancellation recorded', uncertain: 'Worker outcome uncertain' };

function EvidenceTimes({ startedAt, finishedAt }: { startedAt: string | null; finishedAt: string | null }) {
  return <span className={styles.phaseTimes}>{startedAt ? <>Started <time dateTime={startedAt}>{new Date(startedAt).toLocaleString()}</time></> : 'Start time unavailable'}
    {finishedAt ? <>; finished <time dateTime={finishedAt}>{new Date(finishedAt).toLocaleString()}</time></> : null}</span>;
}

/** Intentionally no polling, timer, animation or inferred percentage complete. */
export function EngineeringExecutionEvidence({ evidence }: { evidence?: Evidence }) {
  return <section className={styles.phaseEvidence} aria-label="Execution evidence">
    <h5>Execution evidence</h5>
    <p className={styles.note}>Recorded phases at this sample—not a live process check. Worker completion and evaluator settlement do not mean acceptance.</p>
    {!evidence ? <p className={styles.phaseUnknown}>This response did not provide phase evidence. The runtime may not support it, or the report reached its size limit.</p> :
      evidence.sourceState === 'unavailable' ? <p className={styles.phaseUnknown}>{engineeringPhaseReasons[evidence.reason ?? 'phase-evidence-unavailable']}</p> : <>
        {evidence.seed ? <div className={styles.phaseSeed}><strong>{seedLabel[evidence.seed.state]}</strong>
          {evidence.seed.startedAt ? <EvidenceTimes {...evidence.seed} /> : null}</div> : null}
        {evidence.runs.length === 0 ? <p>No generation runs recorded in this sample.</p> : evidence.runs.map(run => <details key={run.runId} className={styles.phaseRun}>
          <summary>Generation {run.generation}<span>Recorded state: {run.state}; {run.workers.length} worker {run.workers.length === 1 ? 'slot' : 'slots'}, {run.evaluators.length} evaluator {run.evaluators.length === 1 ? 'lane' : 'lanes'}</span></summary>
          <p className={styles.note}>Run <code>{run.runId}</code></p>
          <ul className={styles.phaseLanes} aria-label={`Generation ${run.generation} evidence lanes`}>
            {run.workers.map(worker => <li key={worker.taskId}>
              <span className={styles.phaseKind}>Worker</span><div><strong>{workerLabel[worker.state]}</strong><span>Variant <code>{worker.variantId}</code></span>
                <EvidenceTimes {...worker} /><span>Task <code>{worker.taskId}</code></span></div>
            </li>)}
            {run.evaluators.map(evaluator => <li key={evaluator.trialId}>
              <span className={styles.phaseKind}>Evaluator</span><div><strong>{evaluatorLabel[evaluator.state]}</strong><span>Trial <code>{evaluator.trialId}</code></span>
                <span>{evaluator.variantId === null ? 'Variant attribution awaits the trial record' : <>Variant <code>{evaluator.variantId}</code></>}</span>
                <EvidenceTimes {...evaluator} /></div>
            </li>)}
          </ul>
          {!run.evaluators.length ? <p className={styles.note}>No built-in evaluator custody recorded for this run. Evaluation is not inferred from worker completion.</p> : null}
        </details>)}
      </>}
  </section>;
}
