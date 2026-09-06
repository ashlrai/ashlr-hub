import { useEffect, useRef, useState } from 'react';
import { StatusBadge } from '../../components/primitives/StatusBadge.js';
import { RefreshIndicator } from '../../components/primitives/RefreshIndicator.js';
import { SkeletonLine } from '../../components/primitives/Skeleton.js';
import { useQuery, useRefetch } from '../../data/hooks.js';
import { universeOverviewQuery } from '../../data/queries.js';
import type { UniverseRun, UniverseSummary, UniverseTrial } from '../../data/api-types.js';
import { useScrollRestore } from '../../hooks/useScrollRestore.js';
import styles from './UniverseView.module.css';

function number(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function duration(ms: number): string {
  return ms < 1_000
    ? `${ms.toLocaleString(undefined, { maximumFractionDigits: 0 })} ms`
    : `${(ms / 1_000).toLocaleString(undefined, { maximumFractionDigits: 2 })} s`;
}

function timestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function FirstExperiment() {
  return (
    <section className={styles.empty} aria-labelledby="universe-start-title">
      <h2 id="universe-start-title">Start your first universe</h2>
      <p>Run two measured generations on a disposable seed, then inspect which variants earned a place in the archive.</p>
      <pre className={styles.command}><code>ashlr universe demo</code></pre>
      <p>The local demonstration needs no model credentials. Refresh this page after running it.</p>
      <details>
        <summary>Bring your own experiment</summary>
        <pre className={styles.command}><code>{'ashlr universe init --manifest path/to/universe.json\nashlr universe run <id>\nashlr universe status <id> --json\nashlr universe archive <id> --json'}</code></pre>
      </details>
    </section>
  );
}

function selectionReason(trial: UniverseTrial, summary: UniverseSummary, run: UniverseRun): string {
  if (trial.status !== 'passed') return 'Not admitted. The trial did not finish with a passing measurement.';
  if (run.status !== 'completed') return 'This generation has not completed. Its measurements have not been admitted to the archive.';
  if (trial.selected && trial.delta === null) return 'Established the first measured elite in this niche.';
  if (trial.selected) return `Admitted in generation ${run.generation} after an improvement of ${number(trial.delta!)} over the prior niche elite.`;
  return `Not admitted in this generation. Selection compares passing trials within each niche and requires an improvement of ${number(summary.manifest.metric.minImprovement)}.`;
}

function GenerationEvidence({ trial }: { trial: UniverseTrial }) {
  const receipt = trial.generation;
  if (!receipt) return <p className={styles.hypothesis}>Operator command. Model usage was not measured.</p>;
  const tokenCount = (value: number | null) => value === null ? 'Unavailable' : number(value);
  return (
    <section className={styles.generationEvidence} aria-label="Model generation evidence">
      <div className={styles.detailHeading}><h4>Model generation</h4><StatusBadge status={receipt.status} tone={receipt.status === 'succeeded' ? 'success' : undefined} /></div>
      <dl className={styles.measurements}>
        <div><dt>Model</dt><dd>{receipt.model}</dd></div>
        <div><dt>Accounting</dt><dd>{receipt.usage.state === 'reported' ? 'Provider-reported' : 'Unavailable'}</dd></div>
        <div><dt>Input tokens</dt><dd>{tokenCount(receipt.usage.inputTokens)}</dd></div>
        <div><dt>Output tokens</dt><dd>{tokenCount(receipt.usage.outputTokens)}</dd></div>
        <div><dt>Generation duration</dt><dd>{duration(receipt.durationMs)}</dd></div>
        <div><dt>Request</dt><dd>{receipt.requestStarted ? 'Started' : 'Not started'}</dd></div>
      </dl>
      <details className={styles.artifact}>
        <summary>Generation source and changes</summary>
        <dl>
          <div><dt>Provider</dt><dd>{receipt.provider}</dd></div>
          <div><dt>Endpoint</dt><dd><code>{receipt.endpoint}</code></dd></div>
          <div><dt>Changed files</dt><dd>{receipt.changedFiles.length ? receipt.changedFiles.join(', ') : 'None'}</dd></div>
          <div><dt>Prompt digest</dt><dd><code>{receipt.promptDigest ?? 'Unavailable'}</code></dd></div>
          <div><dt>Response digest</dt><dd><code>{receipt.responseDigest ?? 'Unavailable'}</code></dd></div>
        </dl>
      </details>
      <p>Generation success means a valid replacement response, not evaluator acceptance. Token counts come from the endpoint response; model identity is the configured name.</p>
    </section>
  );
}

function TrialDetail({ trial, summary, run }: { trial: UniverseTrial; summary: UniverseSummary; run: UniverseRun }) {
  const parent = summary.runs.flatMap((item) => item.trials).find((item) => item.id === trial.parentTrialId);
  const current = summary.elites.some((elite) => elite.trialId === trial.id);
  const variant = summary.manifest.variants.find((item) => item.id === trial.variantId);
  return (
    <section className={styles.trialDetail} aria-label={`Evidence for ${trial.variantId}`}>
      <div className={styles.detailHeading}>
        <h3>{trial.variantId}</h3>
        <StatusBadge status={trial.status} tone={trial.status === 'passed' ? 'success' : undefined} />
      </div>
      {variant ? <p className={styles.hypothesis}>{variant.hypothesis}</p> : null}
      <div className={styles.lineage} aria-label="Variant lineage">
        <span>{trial.parentTrialId ? (parent?.variantId ?? trial.parentTrialId) : 'Seed'}</span>
        <span aria-hidden="true">→</span>
        <strong>{trial.variantId}</strong>
        <span className={styles.generation}>Generation {run.generation}</span>
      </div>
      <p className={styles.reason}>{selectionReason(trial, summary, run)}</p>
      {trial.selected ? <p className={styles.currentElite}>{summary.sourceState === 'degraded' ? 'Admission recorded; the current niche elite could not be verified.' : current ? 'Current niche elite' : 'Previously admitted; a later trial now holds this niche.'}</p> : null}
      <dl className={styles.measurements}>
        <div><dt>{summary.manifest.metric.name}</dt><dd>{trial.score === null ? 'Not measured' : number(trial.score)}</dd></div>
        <div><dt>Improvement over prior elite</dt><dd>{trial.delta === null ? 'No prior comparison' : number(trial.delta)}</dd></div>
        <div><dt>Trial duration</dt><dd>{duration(trial.durationMs)}</dd></div>
        {Object.entries(trial.metrics).filter(([key]) => key !== summary.manifest.metric.name).map(([key, value]) => (
          <div key={key}><dt>{key}</dt><dd>{number(value)}</dd></div>
        ))}
      </dl>
      <GenerationEvidence trial={trial} />
      {trial.error ? <pre role="status" aria-label="Trial failure evidence" className={styles.failureEvidence}>{trial.error}</pre> : null}
      {trial.artifact ? (
        <details className={styles.artifact}>
          <summary>Artifact and evaluator identity</summary>
          <dl>
            <div><dt>Artifact</dt><dd><code>{trial.artifact.path}</code></dd></div>
            <div><dt>Content digest</dt><dd><code>{trial.artifact.digest}</code></dd></div>
            <div><dt>Seed revision</dt><dd><code>{trial.artifact.revision}</code></dd></div>
            <div><dt>Comparator digest</dt><dd><code>{run.comparatorDigest}</code></dd></div>
          </dl>
          <p>For exact local records, run <code>ashlr universe status {summary.manifest.id} --json</code>.</p>
        </details>
      ) : null}
      <details className={styles.artifact}>
        <summary>Raw measurement record</summary>
        <pre>{JSON.stringify(trial, null, 2)}</pre>
      </details>
    </section>
  );
}

function UniverseExperiment({ summary }: { summary: UniverseSummary }) {
  const [runId, setRunId] = useState<string | null>(null);
  const [trialId, setTrialId] = useState<string | null>(null);
  const runs = summary.activeRun && !summary.runs.some((run) => run.id === summary.activeRun!.id)
    ? [...summary.runs, summary.activeRun] : summary.runs;
  const run = runs.find((item) => item.id === runId) ?? summary.activeRun ?? runs.at(-1);
  const trial = run?.trials.find((item) => item.id === trialId) ?? run?.trials.find((item) => item.selected) ?? run?.trials[0];
  const niches = [...new Set(summary.manifest.variants.map((variant) => variant.niche))];
  const totalDuration = runs.reduce((sum, item) => sum + item.durationMs, 0);

  return (
    <>
      <section className={styles.objective} aria-label="Universe objective">
        <h2>{summary.manifest.name}</h2>
        <p>{summary.manifest.objective}</p>
        <dl className={styles.objectiveFacts}>
          <div><dt>Selection metric</dt><dd>{summary.manifest.metric.name} · {summary.manifest.metric.direction}</dd></div>
          <div><dt>Minimum improvement</dt><dd>{number(summary.manifest.metric.minImprovement)}</dd></div>
          <div><dt>Run budget</dt><dd>{summary.manifest.budget.maxTrials} trials / {duration(summary.manifest.budget.maxDurationMs)}</dd></div>
          <div><dt>Parallel trials</dt><dd>{summary.manifest.budget.maxParallel}</dd></div>
        </dl>
      </section>

      {summary.sourceState === 'degraded' ? (
        <div className={styles.notice} role="status"><strong>Some experiment records could not be read.</strong><p>{summary.reasons.join('; ')}</p></div>
      ) : null}
      {summary.activeRun ? (
        <div className={styles.running} role="status">
          <StatusBadge status={summary.activeRun.status} />
          <span>Generation {summary.activeRun.generation}: {summary.activeRun.trials.length} trial measurements recorded. Refreshing every 3 seconds.</span>
        </div>
      ) : null}

      <section className={styles.archive} aria-labelledby="universe-archive-title">
        <div className={styles.sectionHeading}>
          <div><h2 id="universe-archive-title">Population archive</h2><p>Each niche keeps its best measured variant. Inspect an elite to see the experiment that earned its place.</p></div>
          <span className={styles.archiveCount}>{summary.sourceState === 'degraded' ? 'Archive incomplete' : `${summary.elites.length} / ${niches.length} niches populated`}</span>
        </div>
        <div className={styles.tableScroll}>
          <table className={styles.archiveTable}>
            <thead><tr><th scope="col">Niche</th><th scope="col">Retained variant</th><th scope="col">{summary.manifest.metric.name}</th><th scope="col">Generation</th></tr></thead>
            <tbody>{niches.map((niche) => {
              const elite = summary.elites.find((item) => item.niche === niche);
              return (
                <tr key={niche} data-selected={elite?.trialId === trial?.id || undefined}>
                  <th scope="row"><span className={elite ? styles.nicheFilled : styles.nicheEmpty} aria-hidden="true" />{niche}</th>
                  <td>{elite ? (
                    <button type="button" className={styles.eliteButton} aria-label={`Inspect ${elite.variantId} in ${niche}`} onClick={() => { setRunId(elite.runId); setTrialId(elite.trialId); }}>{elite.variantId}</button>
                  ) : <span className={styles.muted}>{summary.sourceState === 'degraded' ? 'History incomplete' : 'No retained variant'}</span>}</td>
                  <td>{elite ? number(elite.score) : summary.sourceState === 'degraded' ? 'Unavailable' : 'Not measured'}</td>
                  <td>{elite ? elite.generation : '—'}</td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      </section>

      {run ? (
        <section className={styles.comparison} aria-labelledby="universe-comparison-title">
          <div className={styles.sectionHeading}>
            <div><h2 id="universe-comparison-title">Experiment comparison</h2><p>Selection is local to a niche. Positive improvement means better in either metric direction.</p></div>
            <label className={styles.selectLabel}>Generation
              <select value={run.id} onChange={(event) => { setRunId(event.target.value); setTrialId(null); }}>
                {[...runs].reverse().map((item) => <option key={item.id} value={item.id}>{item.generation} · {item.status}</option>)}
              </select>
            </label>
          </div>
          <div className={styles.runMeta}><StatusBadge status={run.status} tone={run.status === 'completed' ? 'success' : undefined} /><span>Started {timestamp(run.startedAt)}</span><span>{duration(run.durationMs)} recorded</span><span>{run.trials.filter((item) => item.status === 'passed').length} / {run.trials.length} trials passed</span><span>{run.status === 'completed' ? `${run.trials.filter((item) => item.selected).length} admitted` : run.status === 'running' ? 'Selection pending' : 'Selection not applied'}</span></div>
          {run.error ? <p className={styles.failure} role="status">{run.error}</p> : null}
          {trial ? (
            <div className={styles.comparisonBody}>
              <div className={styles.trialList} aria-label="Trials">
                {run.trials.map((item) => (
                  <button type="button" key={item.id} className={styles.trialButton} aria-pressed={item.id === trial.id} onClick={() => setTrialId(item.id)}>
                    <span className={styles.trialTitle}>{item.variantId}<span>{item.score === null ? '—' : number(item.score)}</span></span>
                    <span className={styles.trialSubline}>{item.niche}<span>{item.selected ? 'Admitted' : item.status}</span></span>
                  </button>
                ))}
              </div>
              <TrialDetail trial={trial} summary={summary} run={run} />
            </div>
          ) : <p className={styles.noTrials}>No trial measurements have been recorded for this generation yet.</p>}
        </section>
      ) : (
        <section className={styles.empty}>
          <h2>This universe is ready for its first generation</h2>
          <pre className={styles.command}><code>ashlr universe run {summary.manifest.id}</code></pre>
          <p>Run the experiment, then refresh to compare its measurements.</p>
        </section>
      )}

      <footer className={styles.resources} aria-label="Generation resources">
        <h2>Recorded resources</h2>
        <dl><div><dt>Runtime across {runs.length} generations</dt><dd>{duration(totalDuration)}</dd></div><div><dt>Model tokens{run ? ` in generation ${run.generation}` : ''}</dt><dd>{run?.tokensUsed == null ? 'Unavailable' : number(run.tokensUsed)}</dd></div><div><dt>Model cost</dt><dd>Unavailable</dd></div></dl>
        {run?.generationUsage ? <p>Generation usage coverage: {run.generationUsage.reportedRequests} / {run.generationUsage.requestsStarted} recorded started requests reported tokens across {run.generationUsage.trials} model trials. Totals require a completed generation, at least one recorded request, and usage from every recorded request. Interrupted in-flight usage may be missing.</p> : null}
        <p>Tokens cover model generation only, not command or evaluator work. Missing usage and dollar costs stay unavailable. Evaluator scores do not establish business value or accepted production changes.</p>
      </footer>
    </>
  );
}

export function UniverseView() {
  const containerRef = useRef<HTMLDivElement>(null);
  useScrollRestore('/universe', containerRef);
  const query = useQuery(universeOverviewQuery);
  const refresh = useRefetch(universeOverviewQuery);
  const [universeId, setUniverseId] = useState<string | null>(null);
  const overview = query.data;
  const universe = overview?.universes.find((item) => item.manifest.id === universeId) ?? overview?.universes[0];
  const isRunning = overview?.universes.some((item) => item.activeRun !== null) ?? false;
  useEffect(() => {
    if (!isRunning) return;
    const timer = window.setInterval(refresh, 3_000);
    return () => window.clearInterval(timer);
  }, [isRunning, refresh]);
  return (
    <div ref={containerRef} className={styles.view}>
      <header className={styles.header}>
        <div><h1>Ashlr Universe</h1><p>Run experiments. Compare futures. Keep what earns its place.</p></div>
        <div className={styles.actions}>
          {overview && overview.universes.length > 1 ? (
            <label className={styles.selectLabel}>Universe<select value={universe?.manifest.id} onChange={(event) => setUniverseId(event.target.value)}>{overview.universes.map((item) => <option value={item.manifest.id} key={item.manifest.id}>{item.manifest.name}</option>)}</select></label>
          ) : null}
          <button type="button" className={styles.refresh} onClick={refresh} disabled={query.status === 'loading' || query.status === 'refreshing'}>Refresh</button>
        </div>
      </header>
      <div className={styles.freshness} aria-live="polite">
        {query.status === 'refreshing' ? <RefreshIndicator /> : null}
        {overview ? <span>Observed {timestamp(overview.sampledAt)}{query.status === 'error' ? ' · Last successful read' : ''}</span> : null}
        {overview ? <span>Local experiments</span> : null}
      </div>
      {query.status === 'loading' ? <section className={styles.empty} aria-label="Loading Universe experiments"><SkeletonLine width="60%" /><SkeletonLine width="90%" /><SkeletonLine width="80%" /></section> : null}
      {query.status === 'error' ? <div className={styles.notice} role="alert"><h2>Universe records unavailable</h2><p>{query.error?.message ?? 'The experiment store could not be read.'}</p><p>Refresh to retry. Any records below are from the last successful read.</p></div> : null}
      {overview?.sourceState === 'degraded' ? <div className={styles.notice} role="status"><strong>Experiment history is incomplete.</strong><p>{overview.reasons.join('; ') || 'Some persisted records could not be verified.'}</p></div> : null}
      {universe ? <UniverseExperiment key={universe.manifest.id} summary={universe} /> : overview && overview.sourceState !== 'degraded' ? <FirstExperiment /> : null}
    </div>
  );
}
