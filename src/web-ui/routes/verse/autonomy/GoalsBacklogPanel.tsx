/**
 * routes/verse/autonomy/GoalsBacklogPanel.tsx — read-only context for what the
 * loop is aiming at and what it has queued.
 *
 * V2 is explicit that goal mutation stays out of this surface, so there are no
 * mutation controls here — only disclosures over the two existing reads. `GET /api/backlog`
 * returns `null` when no backlog has been built, which is "not yet", not an
 * error, and renders as such.
 */
import { useId, useState } from 'react';
import { SkeletonRow } from '../../../components/primitives/Skeleton.js';
import { useQuery } from '../../../data/hooks.js';
import { verseBacklogQuery, verseGoalsQuery } from './control-queries.js';
import { formatWholePercent, repoDisplayName, UNKNOWN } from './format.js';
import styles from './autonomy.module.css';

const MAX_ROWS = 8;

export function GoalsBacklogPanel() {
  const goals = useQuery(verseGoalsQuery);
  const backlog = useQuery(verseBacklogQuery);
  const [goalsExpanded, setGoalsExpanded] = useState(false);
  const [backlogExpanded, setBacklogExpanded] = useState(false);
  const goalsListId = useId();
  const backlogListId = useId();

  const openGoals = (goals.data ?? []).filter((g) => g.status !== 'done' && g.status !== 'archived');
  const activeCount = openGoals.filter((g) => g.status === 'active').length;
  const pausedCount = openGoals.filter((g) => g.status === 'paused').length;
  const planningCount = openGoals.filter((g) => g.status === 'planning').length;
  const items = backlog.data?.items ?? [];

  return (
    <section className={styles.panel} aria-label="Goals and backlog">
      <div className={styles.panelHead}>
        <h3 className={styles.panelTitle}>Goals and backlog</h3>
        <p className={styles.panelNote}>Read-only in this view.</p>
      </div>

      <div className={styles.summaryColumns}>
        <div>
          <p className={styles.factLabel}>Goals</p>
          {goals.data && goals.status !== 'error' && goals.status !== 'loading' ? (
            <p className={styles.panelNote}>{activeCount} active · {pausedCount} paused · {planningCount} planning</p>
          ) : null}
          {goals.status !== 'error' && (goals.status === 'loading' || goals.data === undefined) ? (
            <div className={styles.skeletons}>
              <SkeletonRow />
              <SkeletonRow />
            </div>
          ) : goals.status === 'error' ? (
            <p className={styles.error} role="alert">
              {goals.error?.message ?? 'Could not read goals.'}
            </p>
          ) : openGoals.length === 0 ? (
            <p className={styles.empty}>
              No active goals, paused goals or planning goals. Add one with{' '}
              <code>ashlr goals add "&lt;objective&gt;"</code>.
            </p>
          ) : (
            <>
              <div className={styles.summaryList} id={goalsListId}>
                {(goalsExpanded ? openGoals : openGoals.slice(0, MAX_ROWS)).map((goal) => {
                  // One precision for the column: whole percent, "<1%" for a started goal.
                  const done = goal.progress ? formatWholePercent(goal.progress.fractionDone) : UNKNOWN;
                  return (
                    <div className={styles.summaryRow} key={goal.id}>
                      <span className={styles.summaryTitle} title={goal.objective}>
                        {goal.objective}
                      </span>
                      <span className={styles.summaryMeta}>
                        {done} · {goal.status}
                      </span>
                    </div>
                  );
                })}
              </div>
              {openGoals.length > MAX_ROWS ? (
                <button type="button" className={styles.button} aria-expanded={goalsExpanded}
                  aria-controls={goalsListId} aria-label={goalsExpanded ? 'Collapse goals' : `Expand all goals (${openGoals.length})`}
                  onClick={() => setGoalsExpanded((expanded) => !expanded)}>
                  {goalsExpanded ? 'Collapse' : `Expand all (${openGoals.length})`}
                </button>
              ) : null}
            </>
          )}
        </div>

        <div>
          <p className={styles.factLabel}>Backlog</p>
          {backlog.status !== 'error' && (backlog.status === 'loading' || backlog.data === undefined) ? (
            <div className={styles.skeletons}>
              <SkeletonRow />
              <SkeletonRow />
            </div>
          ) : backlog.status === 'error' ? (
            <p className={styles.error} role="alert">
              {backlog.error?.message ?? 'Could not read the backlog.'}
            </p>
          ) : backlog.data?.absent ? (
            <p className={styles.empty}>
              No backlog has been built yet. Run one tick from Controls, or <code>ashlr backlog</code>, to produce one.
            </p>
          ) : items.length === 0 ? (
            <p className={styles.empty}>
              The backlog is empty, so a tick records <code>no-backlog</code> and idles. Enroll another repository in
              Scope, or add a goal, to give it work.
            </p>
          ) : (
            <>
              <div className={styles.summaryList} id={backlogListId}>
                {(backlogExpanded ? items : items.slice(0, MAX_ROWS)).map((item, i) => (
                  <div className={styles.summaryRow} key={item.id ?? `${item.title ?? 'item'}-${i}`}>
                    <span className={styles.summaryTitle} title={item.title}>
                      {item.title ?? item.id ?? 'untitled item'}
                    </span>
                    <span className={styles.summaryMeta} title={item.repo ?? undefined}>
                      {item.repo ? repoDisplayName(item.repo) : UNKNOWN}
                      {typeof item.score === 'number' ? ` · ${item.score}` : ''}
                    </span>
                  </div>
                ))}
              </div>
              {items.length > MAX_ROWS ? (
                <button type="button" className={styles.button} aria-expanded={backlogExpanded}
                  aria-controls={backlogListId} aria-label={backlogExpanded ? 'Collapse backlog' : `Expand all backlog items (${items.length})`}
                  onClick={() => setBacklogExpanded((expanded) => !expanded)}>
                  {backlogExpanded ? 'Collapse' : `Expand all (${items.length})`}
                </button>
              ) : null}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
