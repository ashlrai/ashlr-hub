import { useCallback, useEffect, useRef, useState } from 'react';
import { EngineeringSupervision } from './EngineeringSupervision.js';
import { EngineeringSuccessors } from './EngineeringSuccessors.js';
import { EngineeringObjectiveComposer } from './EngineeringObjectiveComposer.js';
import { EngineeringOutcomes } from './EngineeringOutcomes.js';
import type { ResourceConsoleEngineeringEnrollment as Enrollment, ResourceConsoleEngineeringJob as Job,
  ResourceConsoleEngineeringReadiness as Readiness } from '../../../core/resources/console-engineering-types.js';
import { StatusBadge, type Tone } from '../../components/primitives/StatusBadge.js';
import { controlWorkspaceEngineering, engineeringReadinessReasons, listWorkspaceEngineering, readWorkspaceEngineering,
  readWorkspaceEngineeringReadiness } from '../../data/workspace-engineering.js';
import { resourceReason, resourceTime } from '../resources/CapacityBoard.js';
import styles from './WorkspaceEngineering.module.css';

const duration = (ms: number) => ms < 60_000 ? `${Math.ceil(ms / 1000)}s` : ms < 3_600_000 ? `${Math.ceil(ms / 60_000)}m` : `${(ms / 3_600_000).toFixed(1)}h`;
const tone = (state: Job['state']): Tone => state === 'completed' ? 'success' : state === 'running' ? 'running' : state === 'ready' ? 'neutral' : state === 'unavailable' ? 'unknown' : 'warning';
const label = (state: Job['state']) => state === 'completed' ? 'Recorded delivery' : state === 'ready' ? 'Not started' : state === 'incomplete' ? 'Needs reconciliation' : state;
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : 'Engineering evidence is unavailable.';

/** Observation can poll; launch/cancel only come from explicit user events. */
export function WorkspaceEngineering({ projectId, projectName, available, canStart, canStop, unlocked, onUnlock, startBlockedReason, supervisionSupported, successorsSupported, preparationSupported, preparationAvailable, outcomesSupported, autoAdmission, controlsAvailable = true }: {
  projectId: string; projectName: string; available: boolean; canStart: boolean; canStop: boolean; unlocked: boolean; onUnlock(): void; startBlockedReason?: string;
  supervisionSupported?: boolean;
  successorsSupported?: boolean;
  preparationSupported?: boolean;
  preparationAvailable?: boolean;
  outcomesSupported?: boolean;
  autoAdmission?: boolean;
  controlsAvailable?: boolean;
}) {
  const [allEnrollments, setCatalog] = useState<Enrollment[] | null>(null);
  const catalog = allEnrollments?.filter(row => row.projectId === projectId) ?? null;
  const catalogRef = useRef(allEnrollments); catalogRef.current = allEnrollments;
  const requestedEnrollments = useRef(new Set<string>());
  const [selection, setSelection] = useState('');
  const [job, setJob] = useState<Job | null>(null);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [readinessError, setReadinessError] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [revision, setRevision] = useState(0);
  const reading = useRef<AbortController | null>(null);
  const mutation = useRef<AbortController | null>(null);
  const mutating = useRef(false);
  const selected = catalog?.find((row) => row.id === selection) ?? catalog?.[0] ?? null;
  const identity = selected ? `${selected.id}:${selected.enrollmentDigest}` : '';
  const currentIdentity = useRef(identity); currentIdentity.current = identity;

  useEffect(() => {
    if (!available) return;
    const abort = new AbortController(); setCatalogError(null);
    void listWorkspaceEngineering(abort.signal).then((rows) => {
      if (!abort.signal.aborted) {
        setCatalog(rows);
        // Keep the initial selected plan stable when automatic descendants arrive.
        setSelection(current => current || rows.find(row => row.projectId === projectId)?.id || '');
      }
    }).catch((cause: unknown) => { if (!abort.signal.aborted) { setCatalog(null); setCatalogError(errorText(cause)); } });
    return () => abort.abort();
  }, [projectId, available, catalogRevision]);

  const refreshRegisteredEnrollments = useCallback((ids: string[]) => {
    let missing = false;
    for (const id of ids) {
      if (requestedEnrollments.current.has(id)) continue;
      requestedEnrollments.current.add(id);
      if (!catalogRef.current?.some(row => row.id === id)) missing = true;
    }
    // One observation-triggered read per newly registered identity, including
    // foreign-project rows. A failed read remains explicit and manually retryable.
    if (missing) setCatalogRevision(value => value + 1);
  }, []);
  const refreshSelectedEvidence = useCallback(() => setRevision(value => value + 1), []);

  useEffect(() => {
    setJob(null); setReadiness(null); setReadinessError(null); setReadError(null); setActionError(null); setNotice(null);
    return () => { reading.current?.abort(); mutation.current?.abort(); };
  }, [identity]);

  useEffect(() => {
    if (!selected || !available) { reading.current?.abort(); return; }
    const abort = new AbortController(); reading.current = abort;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      if (abort.signal.aborted) return;
      if (mutating.current) { timer = setTimeout(() => { void poll(); }, 3000); return; }
      setLoading(true); setReadiness(null); setReadinessError(null);
      let running = false;
      try {
        // Independent reads: a failed admission sample must never hide a recorded
        // run or withhold its stop control. Both are observations, not launch CAS.
        await Promise.all([
          readWorkspaceEngineering(selected!, abort.signal).then((value) => {
            if (abort.signal.aborted) return;
            setJob(value); setReadError(null);
            // Never retry execution. A running owner is the only polling case.
            running = value.state === 'running';
          }).catch((cause: unknown) => { if (!abort.signal.aborted) setReadError(errorText(cause)); }),
          readWorkspaceEngineeringReadiness(selected!, abort.signal).then((value) => {
            if (!abort.signal.aborted) setReadiness(value);
          }).catch((cause: unknown) => { if (!abort.signal.aborted) setReadinessError(errorText(cause)); }),
        ]);
      }
      finally {
        if (!abort.signal.aborted) {
          setLoading(false);
          if (running) timer = setTimeout(() => { void poll(); }, 3000);
        }
      }
    }
    void poll();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [selected, available, revision]);

  useEffect(() => {
    if ((!unlocked || !available) && mutating.current) {
      mutation.current?.abort(); mutating.current = false; setBusy(false);
      setActionError('Connection or control access changed during the request. Refresh evidence; this does not stop an already launched run.');
    }
    return () => mutation.current?.abort();
  }, [unlocked, available]);

  const currentJob = job?.enrollmentId === selected?.id && job?.enrollmentDigest === selected?.enrollmentDigest ? job : null;
  const currentReadiness = readiness?.enrollmentId === selected?.id && readiness?.enrollmentDigest === selected?.enrollmentDigest ? readiness : null;
  const reconcile = currentJob?.state === 'incomplete';
  const continuePending = selected?.allowPendingContinuation === true;
  const launchable = controlsAvailable && available && canStart && !catalogError && !readError && !readinessError && !actionError && !busy && !loading &&
    currentReadiness?.status === 'ready' && currentReadiness.action === (reconcile ? continuePending ? 'continue' : 'reconcile' : 'launch') &&
    currentJob && !currentJob.cancelled && (currentJob.state === 'ready' || reconcile && currentJob.nodes.some((n) => n.state === 'unresolved') && currentJob.nodes.every((n) => n.state !== 'pending'));

  async function act(action: 'start' | 'cancel') {
    if (!controlsAvailable || !selected || mutating.current || (action === 'start' ? !launchable : !canStop || !currentJob?.cancellable)) return;
    if (!unlocked) { onUnlock(); return; }
    const key = identity; const abort = new AbortController(); mutation.current = abort;
    reading.current?.abort(); mutating.current = true; setBusy(true); setActionError(null); setNotice(null); setLoading(false);
    try {
      const value = await controlWorkspaceEngineering(selected, action, abort.signal);
      if (abort.signal.aborted || currentIdentity.current !== key) return;
      setJob(value); setReadError(null);
      setNotice(action === 'cancel' ? 'Stop recorded. Waiting for owned work to drain does not undo an already delivered branch.' : 'Request acknowledged. Only evaluated delivery evidence counts as completion.');
      setRevision((n) => n + 1);
    } catch (cause) {
      if (currentIdentity.current === key && !abort.signal.aborted) setActionError(`${errorText(cause)} Refresh evidence before trying again; this response does not prove that no work started.`);
    } finally {
      mutating.current = false;
      if (!abort.signal.aborted && currentIdentity.current === key) setBusy(false);
    }
  }

  function refresh() { setActionError(null); setNotice(null); setRevision((n) => n + 1); setCatalogRevision((n) => n + 1); }
  return <section className={styles.engineering} aria-label="Project engineering runs">
    <header className={styles.header}><div><p className={styles.eyebrow}>ASHLRVERSE / ENGINEERING</p><h2>From objective to evidence.</h2>
      <p>{projectName} · Evaluated changes, explicit local delivery.</p></div>
      <button type="button" className={styles.button} disabled={!available || busy || loading} onClick={refresh}>Refresh evidence</button></header>
    {supervisionSupported ? <EngineeringSupervision available={available} controlsAvailable={controlsAvailable} unlocked={unlocked} selectedPlan={selected} onUnlock={onUnlock}
      onSelectedEvidenceChange={refreshSelectedEvidence} /> : null}
    {successorsSupported ? <EngineeringSuccessors available={available} projectId={projectId} catalog={allEnrollments}
      onRegisteredEnrollments={refreshRegisteredEnrollments} onInspectEnrollment={id => {
        if (available && catalog?.some(row => row.id === id)) setSelection(id);
      }} /> : null}
    {preparationSupported ? <EngineeringObjectiveComposer projectId={projectId} available={controlsAvailable && available && preparationAvailable !== false} unlocked={unlocked} autoAdmission={autoAdmission}
      onUnlock={onUnlock} onRefresh={refresh} onPrepared={({ enrollment }) => {
        setCatalog(rows => [...(rows ?? []).filter(row => row.id !== enrollment.id), enrollment]);
        setSelection(enrollment.id); setCatalogRevision(n => n + 1); setRevision(n => n + 1);
      }} /> : null}
    {!available ? <p className={styles.warning}>Connection evidence is unavailable. New engineering launches are withheld. Previously recorded status may be stale.</p> : null}
    {startBlockedReason ? <p className={styles.warning}>{startBlockedReason}</p> : null}
    {catalogError ? <p role="alert" className={styles.error}>{catalogError}</p> : null}
    {catalog === null && !catalogError && available ? <p role="status" className={styles.empty}>Reading enrolled engineering plans…</p> : null}
    {catalog?.length === 0 ? <div className={styles.empty}><span className={styles.orbit} aria-hidden="true">◎</span><h3>No engineering plan enrolled for this project.</h3>
      {preparationSupported ? <p>Define an objective above using a host-reviewed evaluation profile. {autoAdmission ? 'Check it, then Prepare and queue admits it to automatic work under the existing supervision deadline.' : 'Check and prepare it, then review local readiness before running.'} Ordinary chat tasks remain available.</p> : <>
        <p>Prepare a reviewed objective with a fixed evaluator, allowed files, workers and budget. The preparation command creates linked campaign and startup catalogs without starting work.</p>
        <p><code>ashlr resources pool engineering prepare --help</code></p>
        <p>Use the returned console configuration to make the plan available here. Ordinary chat tasks remain available.</p></>}
      <p>Opening this panel never invents an objective, enrolls an account or starts a worker.</p></div> : null}
    {selected ? <>
      <div className={styles.selection}><label>Enrolled engineering plan<select aria-label="Enrolled engineering plan" value={selected.id} disabled={busy}
        onChange={(event) => setSelection(event.target.value)}>{catalog!.map((row) => <option key={row.id} value={row.id}>{row.id}</option>)}</select></label>
        <div aria-live="polite">{currentJob ? <StatusBadge status={label(currentJob.state)} tone={tone(currentJob.state)} /> : <StatusBadge status="Awaiting evidence" tone="unknown" />}</div>
      </div>
      <section className={styles.admission} aria-label="Local launch checks">
        <div className={styles.admissionHeading}><h3>Before this plan runs</h3>
          <StatusBadge status={!available ? 'Connection unavailable' : readinessError ? 'Check unavailable' : !currentReadiness ? 'Checking local admission' :
            currentReadiness.status === 'ready' ? currentReadiness.action === 'continue' ? 'Continuation checks passed' : currentReadiness.action === 'reconcile' ? 'Reconciliation checks passed' : 'Local checks passed' :
              currentReadiness.status === 'blocked' ? 'Launch held' : 'No new launch'}
          tone={!available || readinessError || !currentReadiness ? 'unknown' : currentReadiness.status === 'ready' ? 'success' : currentReadiness.status === 'blocked' ? 'warning' : 'neutral'} />
        </div>
        {readinessError ? <p role="alert">{readinessError} Refresh evidence to check again. Recorded runs can still be stopped.</p> : null}
        {currentReadiness?.reasons.length ? <ul className={styles.admissionReasons}>{currentReadiness.reasons.map((reason) => <li key={reason}>{engineeringReadinessReasons[reason]}</li>)}</ul> : null}
        <p>Local observation only. No worker contacted and no quota reserved. Launch rechecks the current state; a change after acceptance may still hold the run.</p>
        {currentReadiness ? <p className={styles.sample}>Sampled <time dateTime={currentReadiness.sampledAt}>{resourceTime(currentReadiness.sampledAt)}</time>. Refresh after resolving a hold; this view never starts or retries work automatically.</p> : null}
      </section>
      <div className={styles.mission}><div className={styles.objective}><span className={styles.eyebrow}>OBJECTIVE SUMMARY</span><h3>{selected.objective}</h3>
        <p>The declared dependency order is preserved. Downstream campaigns require the planned delivery, not just a passing model response.</p></div>
        <dl className={styles.metrics}><div><dt>Campaigns</dt><dd>{selected.campaigns.length}</dd></div><div><dt>Parallel ceiling</dt><dd>{selected.budget.maxParallel}</dd></div>
          <div><dt>Graph time limit</dt><dd>{duration(selected.budget.maxDurationMs)}</dd></div></dl></div>
      <div className={styles.content}><section className={styles.flow} aria-label="Campaign dependency plan"><div className={styles.sectionTitle}><h3>Delivery sequence</h3><span>Declared order · not live campaign status</span></div>
        <ol className={styles.campaigns}>{selected.campaigns.map((campaign, index) => <li key={campaign.id}><span className={styles.number} aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
          <div className={styles.campaign}><h4>{campaign.id}</h4><p>{campaign.objective}</p>
            <p className={styles.dependencies}>{campaign.dependsOn.length ? `Requires delivery from ${campaign.dependsOn.join(', ')}` : 'No prerequisite campaigns'}</p>
            <div className={styles.target}><span>Deliver to</span><code>{campaign.branch}</code></div>
            <details><summary>Campaign resource limits</summary><dl className={styles.limits}>
              <div><dt>Generations</dt><dd>{campaign.campaignBudget.maxGenerations}</dd></div><div><dt>Model requests</dt><dd>{campaign.campaignBudget.maxModelRequests}</dd></div>
              <div><dt>Reported token limit</dt><dd>{campaign.campaignBudget.maxReportedTokens?.toLocaleString() ?? 'Not configured'}</dd></div>
              <div><dt>Campaign time</dt><dd>{duration(campaign.campaignBudget.maxDurationMs)}</dd></div><div><dt>Stagnation limit</dt><dd>{campaign.campaignBudget.maxStagnantGenerations} generations</dd></div>
              <div><dt>Trials per generation</dt><dd>{campaign.budget.maxTrials}</dd></div><div><dt>Trial timeout</dt><dd>{duration(campaign.budget.trialTimeoutMs)}</dd></div>
              {campaign.budget.workerTimeoutMs !== undefined ? <div><dt>Worker timeout (within trial)</dt><dd>{duration(campaign.budget.workerTimeoutMs)}</dd></div> : null}
            </dl><p>These are ceilings, not available account balance. Shared quota, reserves and concurrency are checked at dispatch.</p></details>
          </div></li>)}</ol></section>
        <aside className={styles.inspector} aria-label="Engineering evidence inspector"><h3>Execution evidence</h3>
          <dl className={styles.facts}><div><dt>Graph</dt><dd><code>{selected.graphId}</code></dd></div><div><dt>Original deadline</dt><dd>{currentJob?.deadlineAt ? resourceTime(currentJob.deadlineAt) : 'Not established'}</dd></div>
            <div><dt>Source</dt><dd>{currentJob?.sourceState ?? 'Not read'}</dd></div><div><dt>Durable stop</dt><dd>{currentJob?.cancelled ? 'Recorded' : 'Not recorded'}</dd></div></dl>
          <p><strong>Recovery policy: </strong>{continuePending ? 'May execute declared pending campaigns after verified recovery, within original limits.' : 'Completed evidence only; pending work stays held after interruption.'}</p>
          {currentJob?.nodes.length ? <ul className={styles.receipts} aria-label="Signed graph nodes">{currentJob.nodes.map((node) => <li key={node.id}><strong>{node.id}</strong><StatusBadge status={node.state} tone={node.state === 'completed' ? 'success' : node.state === 'unresolved' ? 'warning' : 'neutral'} />
            {node.artifactDigest ? <details><summary>Artifact digest</summary><code>{node.artifactDigest}</code></details> : <p>No recorded artifact.</p>}</li>)}</ul> : <p>No graph artifact recorded yet.</p>}
          {currentJob?.reasons.length ? <ul className={styles.reasons}>{currentJob.reasons.map((reason, i) => <li key={`${i}:${reason}`}>{resourceReason(reason)}</li>)}</ul> : null}
          <details className={styles.identity}><summary>Enrollment identity</summary><p>Objective summaries may be shortened. This digest binds the full enrolled definitions.</p><code>{selected.enrollmentDigest}</code>{currentJob?.definitionDigest ? <><p>Graph definition</p><code>{currentJob.definitionDigest}</code></> : null}</details>
          <p className={styles.scope}>Acceptance scope: fixed evaluator and local branch only. Recorded evidence is not a deployment or proof that a branch has not changed since delivery.</p>
        </aside></div>
      <footer className={styles.controls}><div><strong>{reconcile ? continuePending ? 'Recover delivery. Continue pending work.' : 'Recover evidence, not repeat work.' : 'One plan. One shared resource ledger.'}</strong>
        <p>{reconcile ? continuePending ? 'May start never-started campaigns using enrolled workers and shared quota after verifying completed work. Original deadlines and account reserves still apply; uncertain work stays held.' : 'Only exact completed-child proof can reconcile this graph, within its original deadline. Unfinished work stays held.' : 'Uses enrolled workers under existing quota and account-reserve policies. No accounts are connected by this action.'}</p></div>
        <div className={styles.actions}><button type="button" className={styles.button} disabled={!controlsAvailable || !canStop || !currentJob?.cancellable || busy} onClick={() => { void act('cancel'); }}>{unlocked ? 'Stop engineering run' : 'Unlock to stop'}</button>
          <button type="button" className={styles.primary} disabled={!launchable} onClick={() => { void act('start'); }}>{busy ? 'Submitting…' : unlocked ? reconcile ? continuePending ? 'Continue pending work' : 'Reconcile completed work' : 'Run enrolled plan' : 'Unlock to run'}</button></div></footer>
      {outcomesSupported ? <EngineeringOutcomes key={`${projectId}:${identity}`} enrollment={selected} available={available} /> : null}
      {loading ? <p role="status" className={styles.message}>Reading graph evidence…</p> : null}
      {readError || actionError ? <p role="alert" className={styles.error}>{actionError ?? readError}</p> : null}
      {notice ? <p role="status" className={styles.message}>{notice}</p> : null}
    </> : null}
  </section>;
}
