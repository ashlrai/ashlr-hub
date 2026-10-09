import { formatProductDisplayText } from '../../../../core/vision/leader-display-text.js';
import { useRef, useState } from 'react';
import { Button } from '../../../components/primitives/Button.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { SurfaceActions } from '../command/actions.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { outcomesQuery, writeOutcome } from './outcomes-queries.js';
import type { OutcomeScope, OutcomeStatus, OutcomeView } from './outcomes-types.js';
import { ENGINE_LABEL, isVerseEngine } from '../verse-model.js';
import styles from './outcomes.module.css';
import { TaskContextToggle } from './TaskContextToggle.js';

const LABEL: Record<OutcomeStatus, string> = {
  'waiting-plan': 'Waiting for a plan', queued: 'Queued', running: 'Running',
  'waiting-verification': 'Waiting for verification', failed: 'Failed', paused: 'Paused', 'plan-verified': 'Plan verified',
};
type Editor = { id: string; revision: number; existing: boolean; desiredOutcome: string; targetRepos: string[]; acceptance: string };
const fresh = (): Editor => ({ id: `outcome-${crypto.randomUUID()}`, revision: 0, existing: false, desiredOutcome: '', targetRepos: [], acceptance: '' });

function managerEngine(engine: string): string {
  return engine === 'grok-cli' ? 'Grok' : isVerseEngine(engine) ? ENGINE_LABEL[engine] : 'Native';
}

function managerStatus(outcome: OutcomeView): string {
  const manager = outcome.manager;
  if (!manager || manager.sourceState !== 'healthy') return 'Manager state is unavailable. Refresh to reconnect.';
  const mode = manager.mode === 'interactive' ? 'Chat manager' : 'Manager';
  if (outcome.status === 'paused') return `${mode} paused`;
  if (manager.running) return `${mode} ${manager.running.intent === 'review' ? 'reviewing' : manager.running.intent === 'replan' ? 'replanning' : 'planning'}`;
  if (manager.next) return `${mode} waiting for the fleet`;
  if (manager.latest?.state === 'failed') return `${mode} stage failed`;
  if (manager.latest?.state === 'aborted') return `${mode} stage stopped`;
  if (manager.latest?.state === 'stale') return `${mode} result no longer current`;
  return `${mode} idle`;
}

export function OutcomesPanel({ actions }: { actions: SurfaceActions }) {
  const read = useQuery(outcomesQuery, { freshMs: 4_000 });
  const refetch = useRefetch(outcomesQuery);
  usePollWhileVisible(refetch, 5_000);
  const [editor, setEditor] = useState<Editor | null>(null);
  // Keep a command through a failed/uncertain request. Replay cannot create a
  // second outcome or turn an old edit into a new current-revision mutation.
  const pendingCommand = useRef<{ key: string; id: string } | null>(null);
  const inFlight = useRef(false);
  // Keep the exact configure body until confirmed or explicitly replace its revision.
  const [managerCommands, setManagerCommands] = useState<Record<string, { id: string; revision: number }>>({});
  const value = read.data;
  const available = read.status !== 'error' && value?.sourceState !== 'degraded' && value?.outcomes !== null && value?.enrollment.sourceState === 'healthy';
  const disabled = !available || actions.busy || actions.readOnly;
  const repos = value?.enrollment.repos ?? [];

  function mutate(action: 'start' | 'edit' | 'pause' | 'resume' | 'manager-configure', id: string, revision: number, scope?: OutcomeScope) {
    const key = JSON.stringify([action, id, revision, scope]);
    if (pendingCommand.current?.key !== key) pendingCommand.current = { key, id: crypto.randomUUID() };
    const savedManagerCommand = Object.hasOwn(managerCommands, id) ? managerCommands[id] : undefined;
    const managerCommand = action === 'manager-configure' ? savedManagerCommand ?? { id: crypto.randomUUID(), revision } : undefined;
    if (managerCommand && !savedManagerCommand) setManagerCommands(current => ({ ...current, [id]: managerCommand }));
    const commandId = managerCommand?.id ?? pendingCommand.current.id;
    const expectedRevision = managerCommand?.revision ?? revision;
    actions.act(async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        await writeOutcome(action, id, commandId, expectedRevision, scope);
        if (action === 'manager-configure') {
          setManagerCommands(current => { const next = { ...current }; delete next[id]; return next; });
        }
        pendingCommand.current = null;
        if (action === 'start' || action === 'edit') setEditor(null);
        refetch();
      } finally { inFlight.current = false; }
    }, action === 'manager-configure' ? 'Enable the manager to plan, delegate and review this outcome within the fleet’s existing authority.'
      : 'Save the desired outcome for the fleet to plan within its existing authority.');
  }

  function edit(outcome: OutcomeView) {
    setEditor({ id: outcome.id, revision: outcome.revision, existing: true, desiredOutcome: outcome.scope.desiredOutcome,
      targetRepos: outcome.scope.targetRepos, acceptance: outcome.scope.acceptance.join('\n') });
    pendingCommand.current = null;
  }

  const acceptance = editor?.acceptance.split('\n').map(line => line.trim()).filter(Boolean) ?? [];
  const latest = editor?.existing ? value?.outcomes?.find(outcome => outcome.id === editor.id) : undefined;
  const valid = !!editor?.desiredOutcome.trim() && editor.targetRepos.length > 0 && acceptance.length > 0
    && editor.targetRepos.every(repo => repos.includes(repo));
  return <section className={styles.panel} aria-labelledby="fleet-outcomes-title">
    <div className={styles.header}>
      <div><h2 id="fleet-outcomes-title">Work for me</h2><p>Describe the result. The Leader plans the work across your resources.</p></div>
      <div className={styles.actions}>
        <Button size="sm" variant="ghost" onClick={refetch}>Refresh outcomes</Button>
        <Button size="sm" variant="primary" disabled={disabled} onClick={() => { setEditor(fresh()); pendingCommand.current = null; }}>New outcome</Button>
      </div>
    </div>
    {read.status === 'error' || !value ? <p role="status">{read.status === 'error' ? 'Outcome records are unavailable. Refresh to reconnect.' : 'Reading outcomes…'}</p>
      : value.sourceState === 'degraded' || value.outcomes === null ? <p role="status">Outcome history is incomplete. Current work and completion are unknown.</p>
        : value.outcomes.length === 0 ? <p className={styles.note}>No saved outcomes. Start with the result you want to achieve.</p> : null}
    {value?.enrollment.sourceState === 'degraded' ? <p role="status">Enrolled repositories are unavailable. Refresh before changing an outcome.</p> : null}
    {editor ? <form className={styles.editor} onSubmit={event => {
      event.preventDefault();
      if (!valid || disabled) return;
      mutate(editor.existing ? 'edit' : 'start', editor.id, editor.revision,
        { desiredOutcome: editor.desiredOutcome.trim(), targetRepos: editor.targetRepos, acceptance });
    }}>
      <label>Desired outcome<textarea required rows={3} value={editor.desiredOutcome}
        onChange={event => setEditor({ ...editor, desiredOutcome: event.target.value })} /></label>
      <fieldset><legend>Repositories</legend><div className={styles.repos}>
        {repos.map(repo => <label key={repo}><input type="checkbox" checked={editor.targetRepos.includes(repo)}
          onChange={event => setEditor({ ...editor, targetRepos: event.target.checked ? [...editor.targetRepos, repo] : editor.targetRepos.filter(path => path !== repo) })} /><span>{repo}</span></label>)}
      </div>{repos.length === 0 ? <p className={styles.note}>Enroll a repository in the fleet to start an outcome.</p> : null}</fieldset>
      <label>How will we know it worked?<textarea required rows={3} value={editor.acceptance}
        placeholder="One observable result per line" onChange={event => setEditor({ ...editor, acceptance: event.target.value })} /></label>
      {editor.existing ? <p className={styles.note}>Changing outcome scope retires the current plan and requests cancellation of its running work.</p>
        : <p className={styles.note}>Start saves your outcome for planning. Work runs within the fleet's existing authority.</p>}
      {latest && latest.revision !== editor.revision ? <p role="status">This outcome changed. Your draft is preserved.
        <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => { setEditor({ ...editor, revision: latest.revision }); pendingCommand.current = null; }}>Use latest revision</Button>
      </p> : null}
      <div className={styles.actions}><Button type="submit" size="sm" variant="primary" disabled={disabled || !valid}>{editor.existing ? 'Save outcome' : 'Start outcome'}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setEditor(null)}>Cancel outcome edit</Button></div>
    </form> : null}
    {read.status !== 'error' && value?.outcomes ? <div className={styles.list}>{value.outcomes.map(outcome => <details key={outcome.id} className={styles.row}>
      <summary><strong>{formatProductDisplayText(outcome.scope.desiredOutcome)}</strong><span data-status={outcome.status}>{LABEL[outcome.status]}</span></summary>
      <div className={styles.detail}>
        {outcome.status === 'waiting-plan' && !outcome.manager ? <p className={styles.note}>The desired result is saved. Waiting for the Leader to refine a plan.</p> : null}
        {outcome.status === 'plan-verified' ? <p className={styles.note}>All active plan tasks have verification or explicit gate evidence. Check the desired result against your acceptance criteria.</p> : null}
        {outcome.manager ? <p className={styles.note} role="status">{managerStatus(outcome)}</p> : null}
        {outcome.manager?.sourceState === 'healthy' && (outcome.manager.running ?? outcome.manager.latest) ? <p className={styles.note}>
          Recorded route: {managerEngine((outcome.manager.running ?? outcome.manager.latest)!.route.engine)} · {(outcome.manager.running ?? outcome.manager.latest)!.route.model}
        </p> : null}
        <p className={styles.note}>Revision {outcome.revision} · {outcome.scope.targetRepos.length} repositories</p>
        <ul>{outcome.scope.acceptance.map(item => <li key={item}>{item}</li>)}</ul>
        {outcome.tasks.length ? <ul aria-label="Outcome tasks">{outcome.tasks.map(task => <li key={task.key}>
          <strong>{formatProductDisplayText(task.title)}</strong><span>{task.state === 'claimed' ? 'Claimed; waiting to start' : task.state}</span>
          {task.repo ? <small>{task.repo}</small> : null}
          {task.runId ? <small>Run {task.runId}</small> : null}
          {task.controllerRunId && task.controllerRunId !== task.runId ? <small>Controller run {task.controllerRunId}</small> : null}
          {task.proposalId ? <small>Proposal {task.proposalId}</small> : null}
          {task.mergeIdentity ? <small>Verified merge {task.mergeIdentity}</small> : null}
          {'id' in task && typeof task.id === 'string' ? <TaskContextToggle outcomeId={outcome.id} taskId={task.id} title={task.title} /> : null}
        </li>)}</ul> : null}
        <div className={styles.actions}>
          {!outcome.manager ? <Button size="sm" variant="primary" disabled={disabled || outcome.status === 'paused'}
            onClick={() => mutate('manager-configure', outcome.id, outcome.revision)}
            title="Enable frontier planning and review; workers use the fleet’s current resources and authority">Enable manager</Button> : null}
          {!outcome.manager && Object.hasOwn(managerCommands, outcome.id) && managerCommands[outcome.id] && managerCommands[outcome.id]!.revision !== outcome.revision ?
            <Button size="sm" variant="ghost" disabled={disabled} onClick={() => {
              setManagerCommands(current => { const next = { ...current }; delete next[outcome.id]; return next; });
            }}>Use current manager revision</Button> : null}
          <Button size="sm" variant="ghost" disabled={disabled} onClick={() => edit(outcome)}>Edit outcome</Button>
          <Button size="sm" variant="ghost" disabled={disabled} onClick={() => mutate(outcome.status === 'paused' ? 'resume' : 'pause', outcome.id, outcome.revision)}>
            {outcome.status === 'paused' ? 'Resume outcome' : 'Pause outcome'}
          </Button>
        </div>
        {!outcome.manager && outcome.status === 'paused' ? <p className={styles.note}>Resume this outcome before enabling its manager.</p> : null}
        <p className={styles.note}>Pause stops new requests and asks running work to stop. External provider jobs may continue until cancellation is confirmed.</p>
      </div>
    </details>)}</div> : null}
  </section>;
}
