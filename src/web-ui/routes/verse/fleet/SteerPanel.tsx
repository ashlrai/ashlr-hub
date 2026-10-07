/**
 * routes/verse/fleet/SteerPanel.tsx — edit and interject (3.15, the Fleet
 * control surface).
 *
 *   Working now   per run: Log (live tail), Interject, Stop
 *   Queue         per task: priority 1–5, retarget to a granted repo, cancel
 *   Goals         per goal: the enrolled repo it targets
 *   Tell the Leader   one line → a standing directive
 *
 * Interject is honest about the engines: fleet runs are headless CLI agents
 * with no live input channel, so a note always STOPS the run and puts it back
 * in the queue with the note appended to its brief (the server answers
 * `mode: 'stop-and-requeue'`). A run with no queue task behind it (a scanned
 * backlog item) gets a follow-up task carrying the note instead.
 *
 * Every write goes through the surface's guarded action (token first) and
 * the lists are re-read from the server afterwards.
 */
import { formatMetric } from '../../../components/charts/format-metric.js';
import { useEffect, useId, useState } from 'react';
import type { FleetLiveRun, FleetLiveSnapshotV1 } from '../../../../core/fleet/fleet-types.js';
import type { FleetControlQueueV1, FleetRunLogV1 } from '../../../../core/fleet/fleet-control-types.js';
import { Button } from '../../../components/primitives/Button.js';
import { Input } from '../../../components/primitives/Input.js';
import { Select } from '../../../components/primitives/Select.js';
import { IconStop } from '../../../components/primitives/icons.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { formatRelative, repoDisplayName } from '../autonomy/format.js';
import type { SurfaceActions } from '../command/actions.js';
import { Card, CardNote, MicroLabel } from '../command/Surface.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { fetchRunLog, fleetQueueQuery, postFleetControl, postLeaderDirective } from './fleet-control-queries.js';
import styles from './fleet-control.module.css';

const LOG_POLL_MS = 3_000;
const QUEUE_POLL_MS = 15_000;

/**
 * Agents producing right now: a dispatch that started and has not ended. Later
 * phases (verifying, judging, landing, watching) belong to a filed proposal,
 * not a live agent — the gates handle those, and Stop halts them.
 */
export function workingRuns(live: FleetLiveSnapshotV1 | null): FleetLiveRun[] {
  if (!live) return [];
  return live.runs.filter((run) =>
    run.phase === 'producing'
    && run.endedAt === null
    && run.outcome === null
    && !run.id.startsWith('task:')
    && !run.id.startsWith('held:'));
}

export interface SteerPanelProps {
  live: FleetLiveSnapshotV1 | null;
  actions: SurfaceActions;
  now: number;
}

export function SteerPanel({ live, actions, now }: SteerPanelProps) {
  const queue = useQuery(fleetQueueQuery, { freshMs: 10_000 });
  const refetchQueue = useRefetch(fleetQueueQuery);
  usePollWhileVisible(refetchQueue, QUEUE_POLL_MS);
  const q = queue.data?.value ?? null;
  const runs = workingRuns(live);

  return (
    <Card title="Steer the fleet" caption="Stop or redirect a run, reorder the queue, retarget goals, tell the Leader">
      <MicroLabel>Working now ({runs.length})</MicroLabel>
      {runs.length === 0 ? (
        <p className={styles.muted}>No run is in flight.</p>
      ) : (
        <ul className={styles.list}>
          {runs.map((run) => (
            <RunRow key={run.id} run={run} actions={actions} now={now} onChanged={refetchQueue} />
          ))}
        </ul>
      )}

      <p className={styles.sectionLabel}><MicroLabel>Queue ({q?.tasks.length ?? 0})</MicroLabel></p>
      {q === null ? (
        <CardNote tone="unknown">{queue.data?.reason ?? 'Reading the queue…'}</CardNote>
      ) : q.tasks.length === 0 ? (
        <p className={styles.muted}>Nothing queued. The Leader and the backlog scan add work on every tick.</p>
      ) : (
        <ul className={styles.list}>
          {q.tasks.map((task) => (
            <TaskRow key={task.id} task={task} repos={q.targets.repos} actions={actions} onChanged={refetchQueue} />
          ))}
        </ul>
      )}

      {q && q.goals.length > 0 ? (
        <>
          <p className={styles.sectionLabel}><MicroLabel>Goals ({q.goals.length})</MicroLabel></p>
          <ul className={styles.list}>
            {q.goals.map((goal) => (
              <GoalRow key={goal.id} goal={goal} paths={q.targets.paths} actions={actions} onChanged={refetchQueue} />
            ))}
          </ul>
        </>
      ) : null}

      <p className={styles.sectionLabel}><MicroLabel>Tell the Leader</MicroLabel></p>
      <DirectiveForm actions={actions} />
    </Card>
  );
}

function RunRow({ run, actions, now, onChanged }: { run: FleetLiveRun; actions: SurfaceActions; now: number; onChanged: () => void }) {
  const [open, setOpen] = useState<'log' | 'interject' | null>(null);
  const [note, setNote] = useState('');
  const noteId = useId();
  // A follow-up needs a GitHub repo to queue on when there is no task behind the run.
  const canInterject = Boolean(run.taskId) || /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/u.test(run.repo);
  const started = run.startedAt ? Date.parse(run.startedAt) : NaN;
  const minutes = Number.isFinite(started) ? Math.max(0, Math.round((now - started) / 60_000)) : null;

  function stopRun(): void {
    actions.act(
      () => postFleetControl({ action: 'stop-run', runId: run.id, ...(run.taskId ? { taskId: run.taskId } : {}) }),
      'Stop this run',
      {
        confirm: { title: 'Stop this run?', body: `"${run.title}" on ${repoDisplayName(run.repo)} halts within a few seconds. Nothing it has not filed is kept; its task goes back to the queue.`, confirmLabel: 'Stop run', destructive: true },
        onDone: onChanged,
      },
    );
  }

  function interject(): void {
    const text = note.trim();
    if (!text) return;
    actions.act(
      () => postFleetControl(run.taskId
        ? { action: 'interject', runId: run.id, taskId: run.taskId, note: text }
        : { action: 'interject', runId: run.id, repo: run.repo, title: run.title, note: text }),
      'Interject on this run',
      {
        onDone: () => {
          setNote('');
          setOpen(null);
          onChanged();
        },
      },
    );
  }

  return (
    <li className={styles.row}>
      <div className={styles.rowHead}>
        <p className={styles.rowTitle}>
          {run.title}
          <span className={styles.rowMeta}>
            {' '}· {repoDisplayName(run.repo)} · {run.engine ?? run.lane ?? 'engine ?'} · {run.phase}{minutes !== null ? ` · ${formatMetric(minutes)} min` : ''}
          </span>
        </p>
        <span className={styles.rowControls}>
          <Button size="sm" variant="ghost" aria-expanded={open === 'log'} onClick={() => setOpen(open === 'log' ? null : 'log')}>
            Log
          </Button>
          <Button size="sm" variant="ghost" aria-expanded={open === 'interject'} onClick={() => setOpen(open === 'interject' ? null : 'interject')} disabled={actions.readOnly || !canInterject} title={canInterject ? undefined : 'This run has no queue task or GitHub repo to requeue on — use Stop.'}>
            Interject
          </Button>
          <Button size="sm" variant="danger" icon={<IconStop />} onClick={stopRun} disabled={actions.readOnly}>
            Stop
          </Button>
        </span>
      </div>
      {open === 'log' ? <RunLog runId={run.id} /> : null}
      {open === 'interject' ? (
        <div className={styles.interject}>
          <label className={styles.muted} htmlFor={noteId}>
            Fleet engines run headless, so this stops the run and queues it again with your note in its brief.
          </label>
          <textarea
            id={noteId}
            className={styles.textarea}
            value={note}
            maxLength={1000}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Use the existing fixture helper; do not touch the CLI."
          />
          <span className={styles.rowControls}>
            <Button size="sm" variant="primary" onClick={interject} disabled={!note.trim() || actions.readOnly} busy={actions.busy}>
              Stop and requeue with note
            </Button>
          </span>
        </div>
      ) : null}
    </li>
  );
}

function RunLog({ runId }: { runId: string }) {
  const [log, setLog] = useState<FleetRunLogV1 | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const load = () => {
      fetchRunLog(runId, controller.signal).then(
        (next) => { if (!cancelled) { setLog(next); setError(null); } },
        (err: unknown) => { if (!cancelled && !(err instanceof DOMException && err.name === 'AbortError')) setError('The run log could not be read.'); },
      );
    };
    load();
    const timer = setInterval(load, LOG_POLL_MS);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
    };
  }, [runId]);
  if (error) return <CardNote tone="unknown">{error}</CardNote>;
  if (!log) return <p className={styles.muted} aria-busy="true">Reading the log…</p>;
  return (
    <div>
      {log.stopRequestedAt ? <p className={styles.muted}>Stop requested {formatRelative(log.stopRequestedAt)}.</p> : null}
      {log.available ? (
        <pre className={styles.log} aria-label="Run log" aria-live="off">
          {log.truncated ? '…\n' : ''}
          {log.lines.map((line) => `${line.kind === 'model-delta' ? '' : `[${line.kind}] `}${line.text}`).join('\n') || '(no output yet)'}
        </pre>
      ) : (
        <CardNote tone="unknown">{log.reason ?? 'No log for this run.'}</CardNote>
      )}
    </div>
  );
}

type QueueTask = FleetControlQueueV1['tasks'][number];

function TaskRow({ task, repos, actions, onChanged }: { task: QueueTask; repos: string[]; actions: SurfaceActions; onChanged: () => void }) {
  const choices = repos.some((r) => r.toLowerCase() === task.repo.toLowerCase()) ? repos : [task.repo, ...repos];
  return (
    <li className={styles.row}>
      <div className={styles.rowHead}>
        <p className={styles.rowTitle}>
          {task.title}
          <span className={styles.rowMeta}> · {task.status} · {task.source} · updated {formatRelative(task.updatedAt)}</span>
        </p>
        <span className={styles.rowControls}>
          <Select
            size="sm"
            aria-label={`Priority of ${task.title}`}
            value={String(task.value)}
            disabled={actions.readOnly}
            onChange={(e) => {
              const value = Number(e.target.value);
              actions.act(() => postFleetControl({ action: 'task-edit', taskId: task.id, value }), 'Reprioritize the task', { onDone: onChanged });
            }}
          >
            {[5, 4, 3, 2, 1].map((v) => (
              <option key={v} value={v}>
                {v === 5 ? 'Priority 5 (highest)' : v === 1 ? 'Priority 1 (lowest)' : `Priority ${v}`}
              </option>
            ))}
          </Select>
          <Select
            size="sm"
            aria-label={`Repo for ${task.title}`}
            value={task.repo}
            disabled={actions.readOnly || task.status === 'dispatched'}
            onChange={(e) => {
              const repo = e.target.value;
              actions.act(() => postFleetControl({ action: 'task-edit', taskId: task.id, repo }), 'Retarget the task', { onDone: onChanged });
            }}
          >
            {choices.map((repo) => (
              <option key={repo} value={repo}>
                {repo}
              </option>
            ))}
          </Select>
          <Button
            size="sm"
            variant="ghost"
            disabled={actions.readOnly || task.status === 'dispatched'}
            onClick={() => actions.act(() => postFleetControl({ action: 'task-cancel', taskId: task.id }), 'Cancel the task', {
              confirm: { title: 'Cancel this task?', body: `"${task.title}" leaves the queue.`, confirmLabel: 'Cancel task', destructive: true },
              onDone: onChanged,
            })}
          >
            Cancel
          </Button>
        </span>
      </div>
    </li>
  );
}

type QueueGoal = FleetControlQueueV1['goals'][number];

function GoalRow({ goal, paths, actions, onChanged }: { goal: QueueGoal; paths: string[]; actions: SurfaceActions; onChanged: () => void }) {
  const choices = goal.project && !paths.includes(goal.project) ? [goal.project, ...paths] : paths;
  return (
    <li className={styles.row}>
      <div className={styles.rowHead}>
        <p className={styles.rowTitle}>
          {goal.objective}
          <span className={styles.rowMeta}> · {goal.status}{goal.missionBound ? ' · bound to a signed mission' : ''}</span>
        </p>
        <span className={styles.rowControls}>
          <Select
            size="sm"
            aria-label={`Target repo for ${goal.objective}`}
            value={goal.project ?? ''}
            disabled={actions.readOnly || goal.missionBound}
            onChange={(e) => {
              const project = e.target.value;
              if (!project) return;
              actions.act(() => postFleetControl({ action: 'goal-retarget', goalId: goal.id, project }), 'Retarget the goal', { onDone: onChanged });
            }}
          >
            {goal.project === null ? <option value="">No repo (planning only)</option> : null}
            {choices.map((path) => (
              <option key={path} value={path}>
                {path}
              </option>
            ))}
          </Select>
        </span>
      </div>
    </li>
  );
}

function DirectiveForm({ actions }: { actions: SurfaceActions }) {
  const [text, setText] = useState('');
  const [sent, setSent] = useState(false);
  function submit(): void {
    const value = text.trim();
    if (!value) return;
    actions.act(() => postLeaderDirective(value), 'Add a Leader directive', {
      onDone: () => {
        setText('');
        setSent(true);
      },
    });
  }
  return (
    <form
      className={styles.directive}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Input
        size="sm"
        label="Directive"
        value={text}
        maxLength={300}
        disabled={actions.readOnly}
        onChange={(e) => {
          setText(e.target.value);
          setSent(false);
        }}
        placeholder="e.g. Prioritise test coverage in ashlrcode this week"
        hint={sent ? 'Added. The Leader reads it on its next run; it never widens the grant.' : 'A standing instruction for the Leader. It never widens the grant.'}
      />
      <Button type="submit" size="sm" variant="subtle" disabled={!text.trim() || actions.readOnly}>
        Add directive
      </Button>
    </form>
  );
}
