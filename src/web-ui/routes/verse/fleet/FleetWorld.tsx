/** Optional, read-only lens over the same Fleet snapshot. No synthetic runs or edges. */
import { useId, useState } from 'react';
import type { FleetLiveSnapshotV1 } from '../../../../core/fleet/fleet-types.js';
import type { OptionalRead } from '../command/surface-data.js';
import { VerseMark } from '../rail-icons.js';
import { runStatus, runTone } from './live-model.js';
import { workingRuns } from './SteerPanel.js';
import styles from './fleet-world.module.css';

export default function FleetWorld({ read, refreshing = false, readFailed = false }: {
  read: OptionalRead<FleetLiveSnapshotV1> | undefined;
  refreshing?: boolean;
  readFailed?: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const filterId = useId();
  const inspectorId = useId();
  const live = read?.value;
  if (!read) return readFailed ? <p role="status">Fleet data could not be read. Try refreshing Fleet.</p> : <p aria-busy="true">Loading the fleet world…</p>;
  if (!live) return <p role="status">{read.reason ?? 'Fleet data is unavailable.'}</p>;

  // Preserve server identities and repository layout between snapshots; a vanished
  // selection must not silently point to another account or task.
  const selected = live.runs.find(run => run.id === selectedId);
  const query = filter.trim().toLocaleLowerCase();
  const runs = live.runs.filter(run => !query || `${run.repo} ${run.title} ${run.engine ?? ''} ${run.model ?? ''}`.toLocaleLowerCase().includes(query));
  const groups = new Map<string, typeof runs>();
  for (const run of runs) {
    const group = groups.get(run.repo);
    if (group) group.push(run); else groups.set(run.repo, [run]);
  }
  const repositories = [...groups.keys()].sort();
  const stamp = Date.parse(live.generatedAt);

  return <section className={styles.world} aria-label="Fleet world">
    <div className={styles.heading}>
      <div><h2>Your agents at work</h2><p>Recorded runs · {live.state}{refreshing ? ' · refreshing' : ''}</p></div>
      <label htmlFor={filterId}>Find a task or repository
        <input id={filterId} type="search" value={filter} onChange={event => setFilter(event.target.value)} />
      </label>
    </div>
    {readFailed ? <p role="status" className={styles.note}>Last recorded snapshot · refresh failed.</p> : null}
    {live.stateReason ? <p className={styles.note}>{live.stateReason}</p> : null}
    <div className={styles.layout}>
      <div className={styles.yard}>
        {repositories.map(repo => <section className={styles.island} key={repo} aria-label={repo}>
          <h3>{repo}</h3>
          <div className={styles.agents}>
            {groups.get(repo)!.map(run => <button type="button" key={run.id}
              className={styles.agent} aria-pressed={selectedId === run.id} aria-controls={inspectorId}
              data-tone={runTone(runStatus(run))} onClick={() => setSelectedId(run.id)}>
              <span className={styles.ghost}><VerseMark size={42} /></span>
              <strong>{run.title}</strong><span>{run.engine ?? run.lane ?? 'Resource not reported'}</span>
              <span className={styles.status}>{runStatus(run)}</span>
            </button>)}
          </div>
        </section>)}
        {runs.length === 0 ? <p>{live.runs.length === 0 ? 'No recorded runs in the current window.' : 'No tasks match your search.'}</p> : null}
      </div>
      <aside id={inspectorId} className={styles.inspector} aria-label="Selected fleet task">
        {selected ? <>
          <p className={styles.eyebrow}>Task inspector</p><h3>{selected.title}</h3>
          <dl>
            <dt>Repository</dt><dd>{selected.repo}</dd>
            <dt>Status</dt><dd>{runStatus(selected)}</dd>
            <dt>Resource</dt><dd>{selected.engine ?? selected.lane ?? 'Not reported'}</dd>
            <dt>Account</dt><dd>{selected.seatId ?? 'Not reported'}</dd>
            <dt>Model</dt><dd>{selected.model ?? 'Not reported'}</dd>
            <dt>Outcome</dt><dd>{selected.outcome ?? 'No recorded outcome yet'}</dd>
          </dl>
          {selected.hold ? <p>Held: {selected.hold.reason}</p> : null}
          {selected.prNumber && /^[\w.-]+\/[\w.-]+$/u.test(selected.repo) ? <a href={`https://github.com/${selected.repo}/pull/${selected.prNumber}`} target="_blank" rel="noreferrer">Review pull request #{selected.prNumber}</a> : null}
          {workingRuns(live).some(run => run.id === selected.id) ? <a href="#fleet-working-runs">Open run logs and controls</a> : null}
        </> : <p>{selectedId ? 'This task is no longer in the current snapshot. Select another recorded run.' : 'Select a ghost to inspect its task, resource and result.'}</p>}
      </aside>
    </div>
    <p className={styles.note}>Snapshot: {Number.isFinite(stamp) ? <time dateTime={live.generatedAt}>{new Date(stamp).toLocaleString()}</time> : 'time not reported'}. Repository groups show membership; collaboration links are not recorded here.</p>
  </section>;
}
