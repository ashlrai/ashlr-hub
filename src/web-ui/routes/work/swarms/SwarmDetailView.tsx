/**
 * routes/work/swarms/SwarmDetailView.tsx — GET /api/swarm/:id. Renders the
 * ported DAG (SwarmDag.tsx) above a plain-text, keyboard-navigable task list
 * — the DAG is a navigation aid, not the only way to reach a task's status/
 * error/result, matching the "run detail was unreachable by keyboard"
 * lesson from the audit (this view has no click-only-reachable content).
 */
import { useRef } from 'react';
import { useParams } from 'react-router-dom';
import { swarmDetailQuery } from '../../../data/queries.js';
import { useQuery } from '../../../data/hooks.js';
import { useScrollRestore } from '../../../hooks/useScrollRestore.js';
import { StatusBadge } from '../../../components/primitives/StatusBadge.js';
import { RefreshIndicator } from '../../../components/primitives/RefreshIndicator.js';
import { SkeletonLine } from '../../../components/primitives/Skeleton.js';
import { SwarmDag, mergeSwarmTasks } from './SwarmDag.js';
import styles from './SwarmDetailView.module.css';

const TASK_ANCHOR_PREFIX = 'dag-task';

function formatDate(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export function SwarmDetailView() {
  const { id } = useParams<{ id: string }>();
  const containerRef = useRef<HTMLDivElement>(null);
  useScrollRestore(`/work/swarms/${id ?? ''}`, containerRef);

  const query = useQuery(swarmDetailQuery(id ?? ''));

  if (!id) {
    return (
      <div className={styles.view}>
        <p className={styles.error} role="alert">
          No swarm id in URL.
        </p>
      </div>
    );
  }

  if (query.status === 'loading') {
    return (
      <div ref={containerRef} className={styles.view}>
        <SkeletonLine width="60%" />
        <SkeletonLine width="30%" />
        <SkeletonLine width="80%" />
      </div>
    );
  }

  if (query.status === 'error' || !query.data) {
    return (
      <div ref={containerRef} className={styles.view}>
        <p className={styles.error} role="alert">
          {query.error?.message ?? `Swarm ${id} not found.`}
        </p>
      </div>
    );
  }

  const swarm = query.data;
  const done = swarm.tasks.filter((t) => t.status === 'done').length;
  const total = Math.max(swarm.plan.tasks.length, swarm.tasks.length);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const dagNodes = mergeSwarmTasks(swarm.plan, swarm.tasks);

  return (
    <div ref={containerRef} className={styles.view}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Swarm {swarm.id}</p>
          <h1 className={styles.title}>{swarm.goal}</h1>
        </div>
        <div className={styles.freshness} aria-live="polite">
          {query.status === 'refreshing' ? <RefreshIndicator /> : null}
          <StatusBadge status={swarm.status} />
        </div>
      </header>

      <div className={styles.burndownRow}>
        <div className={styles.burndownTrack}>
          <div className={styles.burndownFill} style={{ width: `${pct}%` }} />
        </div>
        <span className={styles.burndownLabel}>
          {done}/{total} tasks done ({pct}%)
        </span>
      </div>

      <dl className={styles.metaGrid}>
        <div>
          <dt>Tokens in / out</dt>
          <dd className={styles.numeric}>
            {swarm.usage.tokensIn.toLocaleString()} / {swarm.usage.tokensOut.toLocaleString()}
          </dd>
        </div>
        <div>
          <dt>Est cost</dt>
          <dd className={styles.numeric}>${swarm.usage.estCostUsd.toFixed(4)}</dd>
        </div>
        <div>
          <dt>Parallelism</dt>
          <dd className={styles.numeric}>{swarm.parallel}</dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{formatDate(swarm.createdAt)}</dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>{formatDate(swarm.updatedAt)}</dd>
        </div>
        {swarm.project ? (
          <div>
            <dt>Project</dt>
            <dd className={styles.mono}>{swarm.project}</dd>
          </div>
        ) : null}
      </dl>

      {swarm.escalations && swarm.escalations.length > 0 ? (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Escalations ({swarm.escalations.length})</h2>
          <ul className={styles.escalationList}>
            {swarm.escalations.map((esc, i) => (
              <li key={i} className={styles.escalationItem}>
                <pre className={styles.escalationJson}>{JSON.stringify(esc, null, 2)}</pre>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {swarm.result ? (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Result</h2>
          <p className={styles.resultText}>{swarm.result}</p>
        </section>
      ) : null}

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Task graph</h2>
        <div className={styles.dagWrap}>
          <SwarmDag tasks={dagNodes} taskAnchorPrefix={TASK_ANCHOR_PREFIX} />
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Tasks ({dagNodes.length})</h2>
        <ul className={styles.taskList}>
          {dagNodes.map((task) => (
            <li
              key={task.id}
              id={`${TASK_ANCHOR_PREFIX}-${task.id}`}
              data-focus-key={`swarm-task-${task.id}`}
              className={styles.taskItem}
              tabIndex={-1}
            >
              <div className={styles.taskHeader}>
                <span className={styles.taskId}>{task.id}</span>
                <span className={styles.taskPhase}>{task.phase}</span>
                <StatusBadge status={task.status} />
              </div>
              <p className={styles.taskGoal}>{task.goal}</p>
              {task.deps.length > 0 ? (
                <p className={styles.taskDeps}>depends on: {task.deps.join(', ')}</p>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
