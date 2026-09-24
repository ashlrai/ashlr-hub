/**
 * routes/verse/autonomy/GoalsBacklogPanel.tsx — read-only context for what the
 * loop is aiming at and what it has queued.
 *
 * V2 is explicit that goal mutation stays out of this surface, so there are no
 * controls here at all — only the two existing reads. `GET /api/backlog`
 * returns `null` when no backlog has been built, which is "not yet", not an
 * error, and renders as such.
 */
import { SkeletonRow } from '../../../components/primitives/Skeleton.js';
import { useQuery } from '../../../data/hooks.js';
import { verseBacklogQuery, verseGoalsQuery } from './control-queries.js';
import { formatWholePercent, repoDisplayName, UNKNOWN } from './format.js';
import styles from './autonomy.module.css';

const MAX_ROWS = 8;

export function GoalsBacklogPanel() {
  const goals = useQuery(verseGoalsQuery);
  const backlog = useQuery(verseBacklogQuery);

  const activeGoals = (goals.data ?? []).filter((g) => g.status !== 'done' && g.status !== 'archived');
  const items = backlog.data?.items ?? [];

  return (
    <section className={styles.panel} aria-label="Goals and backlog">
      <div className={styles.panelHead}>
        <h3 className={styles.panelTitle}>Goals and backlog</h3>
        <p className={styles.panelNote}>Read-only in this view.</p>
      </div>

      <div className={styles.summaryColumns}>
        <div>
          <p className={styles.factLabel}>Active goals</p>
          {goals.status === 'loading' ? (
            <div className={styles.skeletons}>
              <SkeletonRow />
              <SkeletonRow />
            </div>
          ) : goals.status === 'error' ? (
            <p className={styles.error} role="alert">
              {goals.error?.message ?? 'Could not read goals.'}
            </p>
          ) : activeGoals.length === 0 ? (
            <p className={styles.empty}>
              No active goals, so the loop falls back to the backlog for work. Add one with{' '}
              <code>ashlr goals add "&lt;objective&gt;"</code>.
            </p>
          ) : (
            <div className={styles.summaryList}>
              {activeGoals.slice(0, MAX_ROWS).map((goal) => {
                // One precision for the column: whole percent, "<1%" for a started goal.
                const done = formatWholePercent(goal.progress?.fractionDone ?? 0);
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
              {activeGoals.length > MAX_ROWS ? (
                <p className={styles.panelNote}>+{activeGoals.length - MAX_ROWS} more</p>
              ) : null}
            </div>
          )}
        </div>

        <div>
          <p className={styles.factLabel}>Backlog</p>
          {backlog.status === 'loading' ? (
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
            <div className={styles.summaryList}>
              {items.slice(0, MAX_ROWS).map((item, i) => (
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
              {items.length > MAX_ROWS ? <p className={styles.panelNote}>+{items.length - MAX_ROWS} more</p> : null}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
