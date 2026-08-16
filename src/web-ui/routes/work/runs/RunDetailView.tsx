/**
 * routes/work/runs/RunDetailView.tsx — GET /api/run/:id. Full RunState:
 * budget/usage, the append-only step log, and the task DAG (id, goal, deps,
 * status, result/error) — deps rendered as jump links to the dependency's
 * own task row so "why did this fail" is traceable without a diagram.
 */
import { useRef } from 'react';
import { useParams } from 'react-router-dom';
import { runDetailQuery } from '../../../data/queries.js';
import { useQuery } from '../../../data/hooks.js';
import { useScrollRestore } from '../../../hooks/useScrollRestore.js';
import { StatusBadge } from '../../../components/primitives/StatusBadge.js';
import { RefreshIndicator } from '../../../components/primitives/RefreshIndicator.js';
import { SkeletonLine } from '../../../components/primitives/Skeleton.js';
import type { RunState, RunTask } from '../../../data/api-types.js';
import styles from './RunDetailView.module.css';

function formatDate(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function taskAnchorId(taskId: string): string {
  return `task-${encodeURIComponent(taskId)}`;
}

export function RunDetailView() {
  const { id } = useParams<{ id: string }>();
  const containerRef = useRef<HTMLDivElement>(null);
  useScrollRestore(`/work/runs/${id ?? ''}`, containerRef);

  const query = useQuery(runDetailQuery(id ?? ''));

  if (!id) {
    return (
      <div className={styles.view}>
        <p className={styles.error} role="alert">
          No run id in URL.
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
          {query.error?.message ?? `Run ${id} not found.`}
        </p>
      </div>
    );
  }

  const run: RunState = query.data;
  const tasksById = new Map(run.tasks.map((t) => [t.id, t]));

  return (
    <div ref={containerRef} className={styles.view}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Run {run.id}</p>
          <h1 className={styles.title}>{run.goal}</h1>
        </div>
        <div className={styles.freshness} aria-live="polite">
          {query.status === 'refreshing' ? <RefreshIndicator /> : null}
          <StatusBadge status={run.status} />
        </div>
      </header>

      <dl className={styles.metaGrid}>
        <div>
          <dt>Engine</dt>
          <dd>{run.engine}</dd>
        </div>
        <div>
          <dt>Provider</dt>
          <dd>{run.provider}</dd>
        </div>
        {run.engineModel ? (
          <div>
            <dt>Model</dt>
            <dd>{run.engineModel}</dd>
          </div>
        ) : null}
        <div>
          <dt>Tokens in / out</dt>
          <dd className={styles.numeric}>
            {run.usage.tokensIn.toLocaleString()} / {run.usage.tokensOut.toLocaleString()}
          </dd>
        </div>
        <div>
          <dt>Est cost</dt>
          <dd className={styles.numeric}>${run.usage.estCostUsd.toFixed(4)}</dd>
        </div>
        <div>
          <dt>Steps</dt>
          <dd className={styles.numeric}>{run.usage.steps}</dd>
        </div>
        <div>
          <dt>Budget (tokens / steps)</dt>
          <dd className={styles.numeric}>
            {run.budget.maxTokens.toLocaleString()} / {run.budget.maxSteps}
          </dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{formatDate(run.createdAt)}</dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>{formatDate(run.updatedAt)}</dd>
        </div>
        {run.terminationReason ? (
          <div>
            <dt>Termination reason</dt>
            <dd>{run.terminationReason}</dd>
          </div>
        ) : null}
      </dl>

      {run.result ? (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Result</h2>
          <p className={styles.resultText}>{run.result}</p>
        </section>
      ) : null}

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Tasks ({run.tasks.length})</h2>
        {run.tasks.length === 0 ? (
          <p className={styles.empty}>No tasks recorded.</p>
        ) : (
          <ul className={styles.taskList}>
            {run.tasks.map((task: RunTask) => (
              <li key={task.id} id={taskAnchorId(task.id)} className={styles.taskItem} tabIndex={-1}>
                <div className={styles.taskHeader}>
                  <span className={styles.taskId}>{task.id}</span>
                  <StatusBadge status={task.status} />
                </div>
                <p className={styles.taskGoal}>{task.goal}</p>
                {task.deps.length > 0 ? (
                  <p className={styles.taskDeps}>
                    depends on:{' '}
                    {task.deps.map((depId, i) => (
                      <span key={depId}>
                        {i > 0 ? ', ' : ''}
                        {tasksById.has(depId) ? (
                          <a href={`#${taskAnchorId(depId)}`} className={styles.depLink}>
                            {depId}
                          </a>
                        ) : (
                          <span className={styles.depMissing}>{depId} (unresolved)</span>
                        )}
                      </span>
                    ))}
                  </p>
                ) : null}
                {task.error ? (
                  <p className={styles.taskError} role="alert">
                    {task.error}
                  </p>
                ) : null}
                {task.usage ? (
                  <p className={styles.taskUsage}>
                    {task.usage.tokensIn.toLocaleString()} / {task.usage.tokensOut.toLocaleString()} tokens · $
                    {task.usage.estCostUsd.toFixed(4)}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Step log ({run.steps.length})</h2>
        {run.steps.length === 0 ? (
          <p className={styles.empty}>No steps recorded.</p>
        ) : (
          <ol className={styles.stepList}>
            {run.steps.map((step, i) => (
              <li key={`${step.ts}-${i}`} className={styles.stepItem}>
                <span className={styles.stepTs}>{formatDate(step.ts)}</span>
                <span className={styles.stepKind}>{step.kind}</span>
                <span className={styles.stepTask}>
                  {step.taskId ? (
                    <a href={`#${taskAnchorId(step.taskId)}`} className={styles.depLink}>
                      {step.taskId}
                    </a>
                  ) : null}
                </span>
                <span className={styles.stepSummary}>{step.summary}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
