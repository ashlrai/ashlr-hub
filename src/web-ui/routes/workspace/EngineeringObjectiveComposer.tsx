import { useEffect, useRef, useState } from 'react';
import type { ResourceConsoleEngineeringProfile as Profile, ResourceConsoleEngineeringObjectivePlan as Plan,
  ResourceConsoleEngineeringObjectivePrepared as Prepared } from '../../../core/resources/console-engineering-preparation-types.js';
import { checkEngineeringObjective, listEngineeringProfiles, prepareEngineeringObjective, validEngineeringObjective } from '../../data/engineering-preparation.js';
import { useMutationHold } from '../../data/hooks.js';
import styles from './EngineeringObjectiveComposer.module.css';

type Props = { projectId: string; available: boolean; unlocked: boolean; onUnlock(): void;
  onPrepared(value: Prepared): void; onRefresh(): void };
const newId = () => `objective-${crypto.randomUUID()}`;
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;

/** Project changes create a separate draft; no objective text enters browser storage. */
export function EngineeringObjectiveComposer(props: Props) {
  return <ObjectiveForm key={props.projectId} {...props} />;
}
function ObjectiveForm({ projectId, available, unlocked, onUnlock, onPrepared, onRefresh }: Props) {
  const hold = useMutationHold();
  const [id, setId] = useState(newId);
  const [name, setName] = useState(''); const [objective, setObjective] = useState('');
  const [profiles, setProfiles] = useState<Profile[] | null>(null); const [profileId, setProfileId] = useState('');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null); const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<'profiles' | 'check' | 'prepare' | null>(null);
  const [uncertain, setUncertain] = useState(false); const [prepared, setPrepared] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const request = useRef<AbortController | null>(null); const epoch = useRef(0); const preparing = useRef(false);
  const selected = profiles?.find(row => row.id === profileId) ?? profiles?.[0] ?? null;
  const input = { id, profileId: selected?.id ?? '', name, objective };
  const enabled = available && unlocked && hold.token !== null;

  useEffect(() => {
    epoch.current++; request.current?.abort(); setPlan(null); setProfiles(null); setBusy(null);
    if (preparing.current) { preparing.current = false; setUncertain(true); setError('Preparation response was interrupted. Keep this objective ID and reconcile it; no launch was requested.'); }
    if (!enabled) return;
    const abort = new AbortController(); request.current = abort; const captured = epoch.current;
    setBusy('profiles');
    void listEngineeringProfiles(projectId, abort.signal).then(rows => {
      if (!abort.signal.aborted && captured === epoch.current) setProfiles(rows);
    }).catch(() => {
      if (!abort.signal.aborted && captured === epoch.current) setError('Profiles could not be read. Refresh after checking control access.');
    }).finally(() => { if (!abort.signal.aborted && captured === epoch.current) setBusy(null); });
    return () => { abort.abort(); request.current?.abort(); };
  }, [projectId, enabled, hold.token, refresh]);

  function edit(change: () => void) {
    if (busy || uncertain || prepared) return;
    epoch.current++; request.current?.abort(); setPlan(null); setError(null); setNotice(null); change();
  }
  async function act(action: 'check' | 'prepare') {
    if (!enabled || busy || prepared || !selected || !validEngineeringObjective(input) || action === 'prepare' && !plan) return;
    const abort = new AbortController(); request.current = abort; const captured = ++epoch.current;
    setBusy(action); setError(null); setNotice(null); preparing.current = action === 'prepare';
    if (action === 'check') setPlan(null);
    try {
      if (action === 'check') {
        const checked = await checkEngineeringObjective(input, selected, abort.signal);
        if (!abort.signal.aborted && captured === epoch.current) setPlan(checked);
      } else {
        const result = await prepareEngineeringObjective(input, selected, plan!, abort.signal);
        if (!abort.signal.aborted && captured === epoch.current) {
          setUncertain(false); setPrepared(true); setPlan(null);
          setNotice('Plan prepared and selected below. Nothing has launched. Review local readiness, then use Run enrolled plan.');
          onPrepared(result);
        }
      }
    } catch (cause) {
      if (!abort.signal.aborted && captured === epoch.current) {
        setError(cause instanceof Error ? cause.message : 'Preparation was not confirmed. Refresh and reconcile the same objective.');
        if (action === 'prepare') setUncertain(true);
      }
    } finally {
      if (captured === epoch.current) { preparing.current = false; if (!abort.signal.aborted) setBusy(null); }
    }
  }
  function refreshProfiles() {
    if (busy) return;
    setError(null); setPlan(null); setRefresh(n => n + 1); onRefresh();
  }
  const invalid = name.length > 0 && bytes(name) > 120 || objective.length > 0 && bytes(objective) > 4000;
  return <section className={styles.composer} aria-label="New engineering objective">
    <header className={styles.header}><h3>Define an engineering objective</h3><p>Choose a host-reviewed evaluation profile. Describe work it can actually measure; objective text cannot change the evaluator or grant wider access.</p></header>
    <div className={styles.columns}><div className={styles.form}>
      {!unlocked ? <><p className={styles.note}>Unlock controls to read profiles and review a plan. Read access alone does not expose preparation profiles.</p>
        <button type="button" className={styles.button} disabled={!available} onClick={onUnlock}>Unlock preparation controls</button></> : null}
      <label className={styles.field}>Evaluation profile<select aria-label="Evaluation profile" value={selected?.id ?? ''}
        disabled={!enabled || !!busy || uncertain || prepared || !profiles?.length} onChange={event => edit(() => setProfileId(event.target.value))}>
        {!profiles?.length ? <option value="">{busy === 'profiles' ? 'Reading profiles…' : 'No profile selected'}</option> : profiles.map(row => <option key={row.id} value={row.id}>{row.label}</option>)}
      </select></label>
      <label className={styles.field}>Objective name<input aria-label="Objective name" value={name} maxLength={120} disabled={!!busy || uncertain || prepared}
        onChange={event => edit(() => setName(event.target.value))} /></label>
      <label className={styles.field}>Engineering objective<textarea aria-label="Engineering objective" value={objective} maxLength={4000} disabled={!!busy || uncertain || prepared}
        onChange={event => edit(() => setObjective(event.target.value))} aria-describedby="objective-preparation-bound" /></label>
      <p id="objective-preparation-bound" className={styles.note}>{bytes(objective).toLocaleString()} / 4,000 UTF-8 bytes. The host fixes files, workers, hypotheses and budgets.</p>
      {invalid ? <p role="alert" className={styles.note}>Use at most 120 UTF-8 bytes for the name and 4,000 for the objective.</p> : null}
      <p className={styles.note}>Objective ID: <code>{id}</code></p>
    </div><aside className={styles.summary} aria-label="Fixed evaluation scope"><h4>What this profile measures</h4>
      {selected ? <><p>{selected.acceptance}</p><dl className={styles.facts}>
        <div><dt>Metric</dt><dd>{selected.metric.name} ({selected.metric.direction})</dd></div><div><dt>Minimum improvement</dt><dd>{selected.metric.minImprovement}</dd></div>
        <div><dt>Model request ceiling</dt><dd>{selected.campaignBudget.maxModelRequests}</dd></div><div><dt>Generation ceiling</dt><dd>{selected.campaignBudget.maxGenerations}</dd></div>
        <div><dt>Campaign time ceiling</dt><dd>{selected.campaignBudget.maxDurationMs / 1000}s</dd></div><div><dt>Reported token ceiling</dt><dd>{selected.campaignBudget.maxReportedTokens?.toLocaleString() ?? 'Not configured'}</dd></div>
        <div><dt>Trials per generation</dt><dd>{selected.trialBudget.maxTrials}</dd></div><div><dt>Trial timeout</dt><dd>{selected.trialBudget.trialTimeoutMs / 1000}s</dd></div>
        <div><dt>Trial parallel ceiling</dt><dd>{selected.trialBudget.maxParallel}</dd></div><div><dt>Generation time ceiling</dt><dd>{selected.trialBudget.maxDurationMs / 1000}s</dd></div>
        <div><dt>Pinned seed commit</dt><dd><code>{selected.seedRevision}</code></dd></div></dl>
        <h5>Mutable files</h5><ul>{selected.files.map(file => <li key={file}>{file}</li>)}</ul>
        <h5>Read-only context</h5>{selected.contextFiles.length ? <ul>{selected.contextFiles.map(file => <li key={file}>{file}</li>)}</ul> : <p>No additional context files.</p>}
        <h5>Enrolled workers</h5><ul>{selected.allowedWorkerIds.map(worker => <li key={worker}>{worker}</li>)}</ul>
      </> : <p>{profiles?.length === 0 ? 'No reviewed evaluation profile is configured for this project. Ask the host operator to enroll one; this form cannot invent acceptance criteria.' : 'Unlock and select a profile to inspect its fixed scope.'}</p>}
      <p>Checks and preparation contact no worker or evaluator. A prepared plan is not accepted work or available provider capacity.</p>
    </aside></div>
    {plan ? <section className={styles.review} aria-label="Checked objective plan"><h4>Review before preparation</h4><p>{plan.name}</p><p>{plan.objective}</p>
      <p>Local delivery branch: <code>{plan.branch}</code>. No checkout, merge or deployment is requested.</p>
      <details><summary>Checked plan identity</summary><code>{plan.planDigest}</code><p>Profile digest: <code>{plan.profileDigest}</code></p></details>
      <p>Prepare registers this exact plan. Running it remains a separate action; preparation does not add it to automatic supervision.</p></section> : null}
    {error ? <p className={`${styles.feedback} ${styles.error}`} role="alert">{error}</p> : null}
    {uncertain ? <p className={styles.feedback}>The preparation outcome is unknown. Keep the same objective ID. Refresh enrolled plans, check again if needed, then explicitly reconcile preparation. This never retries execution.</p> : null}
    {notice ? <p className={styles.feedback} role="status">{notice}</p> : null}
    {!available ? <p className={styles.feedback}>Fresh project and console evidence is required before checking or preparing.</p> : null}
    <div className={styles.actions}><button type="button" className={styles.button} disabled={!enabled || !!busy} onClick={refreshProfiles}>Refresh profiles and enrolled plans</button>
      <button type="button" className={styles.button} disabled={!enabled || !!busy || prepared || !validEngineeringObjective(input)} onClick={() => { void act('check'); }}>{busy === 'check' ? 'Checking plan…' : 'Check plan'}</button>
      <button type="button" className={styles.primary} disabled={!enabled || !!busy || prepared || !plan} onClick={() => { void act('prepare'); }}>{busy === 'prepare' ? 'Preparing plan…' : uncertain ? 'Reconcile preparation' : 'Prepare plan'}</button>
      {prepared ? <button type="button" className={styles.button} disabled={!!busy} onClick={() => { setId(newId()); setName(''); setObjective(''); setPlan(null); setPrepared(false); setNotice(null); setError(null); }}>Define another objective</button> : null}</div>
  </section>;
}
