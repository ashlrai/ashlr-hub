import { useEffect, useRef, useState } from 'react';
import type { UniversePortfolioControllerView } from '../../core/web/universe-console-types.js';
import { isControllerId, readControllerStatus } from '../data/controller-status.js';
import { UniverseControllerTopology } from './UniverseControllerTopology.js';
import styles from './UniverseControllerInspector.module.css';

function RecordedTime({ value }: { value: string | null }) {
  return value ? <time dateTime={value}>{value.replace('T', ' ').replace('Z', ' UTC')}</time> : <>Not recorded</>;
}

/** Named, user-triggered observation. Never polls, discovers controllers or changes their state. */
export function UniverseControllerInspector() {
  const [input, setInput] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [data, setData] = useState<UniversePortfolioControllerView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validation, setValidation] = useState(false);
  const request = useRef<{ sequence: number; abort: AbortController | null }>({ sequence: 0, abort: null });
  useEffect(() => () => { request.current.sequence += 1; request.current.abort?.abort(); }, []);

  async function inspect(id: string) {
    if (!isControllerId(id)) { setValidation(true); return; }
    setValidation(false);
    request.current.abort?.abort();
    const sequence = ++request.current.sequence;
    const abort = new AbortController();
    request.current.abort = abort;
    setSelected(id);
    setData((previous) => previous?.controllerId === id ? previous : null);
    setLoading(true);
    setError(null);
    try {
      const next = await readControllerStatus(id, abort.signal);
      if (sequence === request.current.sequence) setData(next);
    } catch {
      if (sequence === request.current.sequence) setError('Observation failed or returned invalid evidence. Check your connection and refresh this controller.');
    } finally {
      if (sequence === request.current.sequence) setLoading(false);
    }
  }

  return <section className={styles.inspector} aria-labelledby="controller-inspector-title">
    <header className={styles.header}>
      <div><h2 id="controller-inspector-title">Controller inspector</h2>
        <p>Read the recorded progress of a named portfolio controller.</p></div>
      <span className={styles.readOnly}>Read-only</span>
    </header>
    <form className={styles.form} onSubmit={(event) => { event.preventDefault(); void inspect(input); }}>
      <div className={styles.field}><label htmlFor="controller-id">Controller ID</label>
        <input id="controller-id" value={input} onChange={(event) => { setInput(event.target.value); setValidation(false); }}
          maxLength={64} autoComplete="off" autoCapitalize="none" spellCheck={false}
          aria-invalid={validation} aria-describedby="controller-id-help" />
        <p id="controller-id-help">Use the ID from your controller manifest: lowercase letters, numbers, hyphens or underscores.</p>
      </div>
      <button type="submit">Inspect controller</button>
      {selected ? <button type="button" disabled={loading} onClick={() => { void inspect(selected); }}>Refresh controller</button> : null}
    </form>
    {validation ? <p role="alert" className={styles.warning}>Enter 1–64 characters, starting with a lowercase letter or number.</p> : null}
    {!selected ? <p className={styles.empty}>Enter an ID to inspect this store. Nothing is queried until you submit.</p> : <div aria-busy={loading}>
      <h3 className={styles.identity}>Evidence for <code>{selected}</code></h3>
      {input !== selected ? <p className={styles.note}>The form has changed. Evidence below still belongs to {selected}; submit to inspect another ID.</p> : null}
      <p role="status" className={styles.note}>{loading ? `Reading ${selected}…${data ? ' Previous observation remains below.' : ''}` :
        error && data ? 'Historical observation — refresh failed. This is not current evidence.' : data ? 'Recorded snapshot. Refresh explicitly to check for changes; this is not a live process view.' : 'No verified observation is available.'}</p>
      {error ? <p role="alert" className={styles.warning}>{error}</p> : null}
      {data ? <>
        <dl className={styles.facts}>
          <div><dt>Evidence health</dt><dd>{data.sourceState}</dd></div>
          <div><dt>Recorded status</dt><dd>{data.status}</dd></div>
          <div><dt>Observed at</dt><dd><RecordedTime value={data.observedAt} /></dd></div>
          <div><dt>Created at</dt><dd><RecordedTime value={data.createdAt} /></dd></div>
          <div><dt>Original deadline</dt><dd><RecordedTime value={data.deadlineAt} /></dd></div>
        </dl>
        {data.sourceState === 'missing' ? <p className={styles.warning}>No controller registration was found in this store. Check the ID and selected Universe store.</p> : null}
        {data.sourceState === 'degraded' ? <p className={styles.warning}>Evidence could not be fully verified. This observation does not repair locks, reconcile work or prove a controller is running.</p> : null}
        {data.control ? <section className={styles.control} aria-label="Recorded admission control">
          <h4>{data.control.mode === 'open' ? 'Admission reopened' : data.control.acknowledgedAt ? 'Drain acknowledged' : 'Drain awaiting acknowledgement'}</h4>
          <ol className={styles.sequence}>
            <li><strong>{data.control.mode === 'open' ? 'Resume recorded' : 'Drain recorded'}</strong><span>Sequence {data.control.sequence}</span><RecordedTime value={data.control.requestedAt} /></li>
            <li><strong>{data.control.mode === 'open' ? 'Resume did not start work' : data.control.acknowledgedAt ? 'Acknowledgement recorded' : 'Acknowledgement not recorded'}</strong>
              {data.control.mode === 'drain' ? <RecordedTime value={data.control.acknowledgedAt} /> : <span>Resume does not start work.</span>}</li>
          </ol>
          <p>{data.control.mode === 'drain' ? 'Drain blocks new dispatch intents; already-admitted work can continue. An unresolved intent prevents acknowledgement; absence of a visible worker proves neither completion nor failure.' : 'Execution requires a separate run invocation. Admission state does not renew the original deadline or establish a running controller.'}</p>
        </section> : <p className={styles.note}>No admission-control record. This does not establish process liveness.</p>}
        <UniverseControllerTopology key={data.controllerId} data={data} />
        {data.outcomes.length ? <div className={styles.tableWrap} role="region" aria-label="Recorded campaign outcomes" tabIndex={0}>
          <table><caption>Recorded campaign outcomes</caption><thead><tr><th scope="col">Campaign</th><th scope="col">State</th><th scope="col">Campaign attempted</th><th scope="col">Reason</th></tr></thead>
            <tbody>{data.outcomes.map((row) => <tr key={row.campaignId}><th scope="row">{row.campaignId}</th><td>{row.state}</td><td>{row.attempted ? 'Yes' : 'No'}</td><td>{row.reasonCode}</td></tr>)}</tbody></table>
        </div> : <p className={styles.note}>No campaign outcomes available in this observation.</p>}
        <p className={styles.note}>“In-flight” means an unresolved durable intent, not proof of a live worker. Campaign attempted records a call intent, not proof of worker execution or successful evaluation. A dispatch-not-started outcome remains held and does not authorize a retry.</p>
        {data.reasons.length ? <details className={styles.reasons}><summary>Evidence reasons ({data.reasons.length})</summary><ul>{data.reasons.map((reason, index) => <li key={`${reason}-${index}`}>{reason}</li>)}</ul></details> : null}
      </> : null}
    </div>}
  </section>;
}
