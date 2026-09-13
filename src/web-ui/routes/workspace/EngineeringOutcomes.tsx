import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ResourceConsoleEngineeringEnrollment as Enrollment } from '../../../core/resources/console-engineering-types.js';
import type { ResourceEngineeringOutcomes as Outcomes, ResourceEngineeringOutcomeUsage as Usage, ResourceEngineeringOutcomeTiming as Timing } from '../../../core/resources/engineering-outcomes-types.js';
import { getAuthSnapshot, subscribeAuth } from '../../data/auth-store.js';
import { engineeringOutcomeReasons, readWorkspaceEngineeringOutcomes, WorkspaceEngineeringOutcomeReadError } from '../../data/workspace-engineering-outcomes.js';
import styles from './EngineeringOutcomes.module.css';
import { EngineeringExecutionEvidence } from './EngineeringExecutionEvidence.js';

const number = (v: number | null) => v === null ? 'Unavailable' : v.toLocaleString();
const authPhase = () => getAuthSnapshot().phase;

function TokenUsage({ value }: { value: Usage }) {
  return <div className={styles.usage}>
    <strong>{value.complete && value.attempts === 0 ? 'No recorded worker attempts' : value.complete ? `${number(value.totalTokens)} reported tokens` : `${number(value.recordedInputTokens + value.recordedOutputTokens)} recorded token subtotal`}</strong>
    <span>{number(value.recordedInputTokens)} input / {number(value.recordedOutputTokens)} output</span>
    <span>{value.reportedAttempts} of {value.attempts} attempts report usage; {value.unknownAttempts} unknown.</span>
    <span>{value.joinedAttempts} attempts joined to shared-ledger receipts.</span>
    {!value.complete ? <span>Total usage is unavailable.</span> : null}
  </div>;
}

function ExecutionTime({ value }: { value: Timing }) {
  return <div className={styles.usage}><strong>{value.attempts === 0 && value.complete ? 'No recorded execution time' :
    `${number(value.complete ? value.totalDurationMs : value.recordedDurationMs)} ms ${value.complete ? 'summed worker execution' : 'recorded execution subtotal'}`}</strong>
    <span>{value.measuredAttempts} of {value.attempts} attempts have measured execution time.</span>
    {!value.complete ? <span>Total execution time is unavailable.</span> : null}</div>;
}

/** Reads only on an operator click. Graph status changes never trigger deep proof reads. */
export function EngineeringOutcomes({ enrollment, available }: { enrollment: Enrollment; available: boolean }) {
  const phase = useSyncExternalStore(subscribeAuth, authPhase, authPhase);
  const identity = `${enrollment.projectId}:${enrollment.id}:${enrollment.enrollmentDigest}:${phase}`;
  const current = useRef(identity); current.current = identity;
  const pending = useRef<AbortController | null>(null);
  const [result, setResult] = useState<{ identity: string; report: Outcomes } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const report = available && result?.identity === identity ? result.report : null;
  useEffect(() => {
    pending.current?.abort(); setResult(null); setError(null); setBusy(false);
    return () => pending.current?.abort();
  }, [identity, available]);
  async function read() {
    if (!available || busy) return;
    const abort = new AbortController(); pending.current = abort;
    const captured = identity; setBusy(true); setError(null);
    try {
      const value = await readWorkspaceEngineeringOutcomes(enrollment, abort.signal);
      if (!abort.signal.aborted && current.current === captured) setResult({ identity: captured, report: value });
    } catch (failure) {
      if (!abort.signal.aborted && current.current === captured) {
        setResult(null); setError(failure instanceof WorkspaceEngineeringOutcomeReadError ? failure.message :
          'Outcome evidence could not be verified. Read it again after checking the connection. No work was started.');
      }
    } finally { if (!abort.signal.aborted && current.current === captured) setBusy(false); }
  }
  return <section className={styles.outcomes} aria-label="Engineering outcomes">
    <header className={styles.header}><div><h3>Engineering outcomes</h3><p>Evaluation and currently verified local delivery, separate from worker task completion.</p></div>
      <button type="button" disabled={!available || busy} onClick={() => { void read(); }}>{busy ? 'Reading outcome evidence…' : report ? 'Refresh outcome evidence' : 'Read outcome evidence'}</button></header>
    {!report && !busy && !error ? <p className={styles.note}>Read evidence for this enrolled plan when you need it. This does not run workers, evaluate candidates or change routing.</p> : null}
    {busy ? <p role="status">Reading campaign and local delivery evidence…</p> : null}
    {error ? <p role="alert" className={styles.warning}>{error}</p> : null}
    {report ? <>
      <div className={styles.overview}><div><p>Sampled <time dateTime={report.sampledAt}>{new Date(report.sampledAt).toLocaleString()}</time>.</p>
        <p>{report.sourceState === 'healthy' ? 'Evidence sources verified at this sample.' : 'Some evidence is unavailable; do not treat missing observations as zero.'}</p>
        <p>{report.complete ? 'Evidence coverage complete.' : 'Evidence coverage incomplete.'} Campaign totals include historical work, not only this graph invocation.</p></div><div className={styles.measurements}><TokenUsage value={report.usage} /><ExecutionTime value={report.timing} /></div></div>
      {report.reasons.length ? <ul className={styles.reasons}>{report.reasons.map((reason, i) => <li key={i}>{engineeringOutcomeReasons[reason]}</li>)}</ul> : null}
      {report.campaigns.map(c => <article key={c.campaignId} className={styles.campaign}>
        <h4>{c.campaignId}</h4><p>{c.state ?? 'State unavailable'}; {c.sourceState === 'healthy' ? 'campaign evidence verified' : 'campaign evidence unavailable'}.</p>
        {c.sourceState === 'healthy' ? <>
        <EngineeringExecutionEvidence evidence={c.phaseEvidence} />
        <div className={styles.tableScroll} role="region" aria-label={`${c.campaignId} evaluation stages`} tabIndex={0}>
          <table><caption>Independent evidence stages</caption><thead><tr>{['Trials', 'Evaluated', 'Passed', 'Rejected', 'Selected', 'Strict improvements', 'Verified local deliveries'].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
            <tbody><tr>{[c.stages.trials, c.stages.evaluated, c.stages.passed, c.stages.rejected, c.stages.selected, c.stages.strictImprovements, c.stages.verifiedLocalDeliveries].map((v, i) => <td key={i}>{number(v)}</td>)}</tr></tbody></table></div>
        <p className={styles.note}>These stages overlap; they are not a funnel or a worker success ranking. A selected first candidate is not automatically a strict improvement.</p>
        <div className={styles.measurement}><div><h5>Fixed evaluator</h5><p>{c.metric ? `${c.metric.name}: ${c.metric.direction}; minimum improvement ${number(c.metric.minImprovement)}.` : 'Metric unavailable.'}</p>
          <p>Seed measurement: {c.seed.status}{c.seed.status === 'measured' ? `; score ${number(c.seed.score)}; ${c.seed.passed === null ? 'verdict unavailable' : c.seed.passed ? 'passed' : 'failed'}` : ''}.</p>
          <p className={styles.note}>Seed comparison is a separate baseline, not a trial parent or a rewritten trial delta.</p></div><div className={styles.measurements}><TokenUsage value={c.usage} /><ExecutionTime value={c.timing} /></div></div>
        {c.niches.length ? <div className={styles.tableScroll} role="region" aria-label={`${c.campaignId} selected candidates`} tabIndex={0}>
          <table><caption>Final selected campaign candidates</caption><thead><tr><th scope="col">Niche</th><th scope="col">Score</th><th scope="col">Direction-adjusted change from seed</th><th scope="col">Run / trial</th></tr></thead>
            <tbody>{c.niches.map(n => <tr key={n.niche}><th scope="row">{n.niche}</th><td>{number(n.score)}</td><td>{number(n.deltaFromSeed)}</td><td><code>{n.runId}</code><br /><code>{n.trialId}</code></td></tr>)}</tbody></table></div> : <p>No final selected campaign candidate is available.</p>}
        <details className={styles.details}><summary>Campaign and worker attribution</summary>
          <dl className={styles.identities}><div><dt>Universe</dt><dd>{c.universeId ?? 'Unavailable'}</dd></div><div><dt>Campaign definition digest</dt><dd><code>{c.definitionDigest ?? 'Unavailable'}</code></dd></div>
            <div><dt>Comparator digest</dt><dd><code>{c.comparatorDigest ?? 'Unavailable'}</code></dd></div>{c.niches.map(n => <div key={n.niche}><dt>{n.niche} artifact digest</dt><dd><code>{n.artifactDigest}</code></dd></div>)}</dl>
          {c.workers.length ? <div className={styles.tableScroll} role="region" aria-label={`${c.campaignId} worker attribution`} tabIndex={0}>
            <table><caption>Observed worker participation, not causal credit</caption><thead><tr><th scope="col">Worker / model</th><th scope="col">Evaluated / passed / rejected</th><th scope="col">Recorded usage and time</th></tr></thead>
              <tbody>{c.workers.map(w => <tr key={w.workerId}><th scope="row">{w.workerId}<span className={styles.block}>{w.provider} / {w.model}</span></th><td>{w.evaluated} / {w.passed} / {w.rejected}</td><td><div className={styles.measurements}><TokenUsage value={w.usage} /><ExecutionTime value={w.timing} /></div></td></tr>)}</tbody></table></div> : <p>No joined worker attribution is available.</p>}
        </details>
        </> : <p className={styles.warning}>Evaluation stages, seed comparison and worker attribution are unavailable for this campaign. No zero-outcome claim is made.</p>}
        {c.reasons.length ? <ul className={styles.reasons}>{c.reasons.map((reason, i) => <li key={i}>{engineeringOutcomeReasons[reason]}</li>)}</ul> : null}
      </article>)}
      <p className={styles.scope}>Fixed evaluator and local branch only. Production acceptance is unmeasured. Reported generation tokens are not billing or full-agent usage. Summed worker execution includes adapter preparation and cleanup, not queue wait, evaluation or wall-clock campaign time. No cross-comparator scores, model rankings or routing changes are inferred.</p>
    </> : null}
  </section>;
}
