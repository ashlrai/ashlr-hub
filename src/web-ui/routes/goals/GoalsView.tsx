/**
 * routes/goals/GoalsView.tsx — active goals and milestone progress
 * (GET /api/goals, GET /api/vision/mission).
 *
 * /api/goals (src/core/web/api.ts:1654-1686) is fully read-only and already
 * degrades to `[]` on any failure — no sourceQuality to wrap there. The
 * Mission Outcome Room summary (/api/vision/mission) DOES carry a real
 * epistemic breakdown per source (`sources.briefing/goals/enrollment/
 * proposals`, each `{sourceState, complete, reason?}` — structurally the
 * same shape as SourceQuality even though it's defined locally in
 * queries.ts because the backend handler itself is untyped
 * `Record<string, unknown>`), so that section is wrapped in <Epistemic/>
 * per-source rather than shown as one blended status.
 */
import { useRef } from 'react';
import { goalsQuery, visionMissionQuery } from '../../data/queries.js';
import { useQuery } from '../../data/hooks.js';
import { useScrollRestore } from '../../hooks/useScrollRestore.js';
import { Epistemic } from '../../components/primitives/Epistemic.js';
import { StatusBadge } from '../../components/primitives/StatusBadge.js';
import { RefreshIndicator } from '../../components/primitives/RefreshIndicator.js';
import { SkeletonLine } from '../../components/primitives/Skeleton.js';
import styles from './GoalsView.module.css';

export function GoalsView() {
  const containerRef = useRef<HTMLDivElement>(null);
  useScrollRestore('/goals', containerRef);

  const goalsResult = useQuery(goalsQuery);
  const missionResult = useQuery(visionMissionQuery);

  const goals = goalsResult.data ?? [];
  const mission = missionResult.data;

  return (
    <div ref={containerRef} className={styles.view}>
      <header className={styles.header}>
        <h1 className={styles.title}>Goals</h1>
        <div className={styles.freshness} aria-live="polite">
          {goalsResult.status === 'refreshing' || missionResult.status === 'refreshing' ? <RefreshIndicator /> : null}
          <span className={styles.count}>{goals.length} goals</span>
        </div>
      </header>

      {missionResult.status === 'loading' ? (
        <SkeletonLine width="50%" />
      ) : missionResult.status === 'success' && mission ? (
        <section className={styles.missionCard}>
          <h2 className={styles.sectionTitle}>Mission state</h2>
          <p className={styles.missionState}>{mission.state}</p>
          <dl className={styles.sourceGrid}>
            <div>
              <dt>Briefing</dt>
              <dd>
                <Epistemic quality={mission.sources.briefing ?? undefined} label="briefing source">
                  available
                </Epistemic>
              </dd>
            </div>
            <div>
              <dt>Goals source</dt>
              <dd>
                <Epistemic quality={mission.sources.goals ?? undefined} label="goals source">
                  available
                </Epistemic>
              </dd>
            </div>
            <div>
              <dt>Enrollment</dt>
              <dd>
                <Epistemic quality={mission.sources.enrollment ?? undefined} label="enrollment source">
                  available
                </Epistemic>
              </dd>
            </div>
            <div>
              <dt>Proposals</dt>
              <dd>
                <Epistemic quality={mission.sources.proposals ?? undefined} label="proposals source">
                  available
                </Epistemic>
              </dd>
            </div>
          </dl>
        </section>
      ) : null}

      {goalsResult.status === 'loading' ? (
        <div className={styles.list}>
          <SkeletonLine width="90%" />
          <SkeletonLine width="70%" />
        </div>
      ) : goalsResult.status === 'error' ? (
        <p className={styles.error} role="alert">
          {goalsResult.error?.message ?? 'Failed to load goals.'}
        </p>
      ) : goals.length === 0 ? (
        <p className={styles.empty}>No active goals.</p>
      ) : (
        <ul className={styles.list}>
          {goals.map((goal) => {
            const pct = Math.round((goal.progress.fractionDone ?? 0) * 100);
            return (
              <li key={goal.id} className={styles.goalCard} data-focus-key={`goal-${goal.id}`} tabIndex={0}>
                <div className={styles.goalHeader}>
                  <h3 className={styles.goalObjective}>{goal.objective}</h3>
                  <StatusBadge status={goal.status} />
                </div>

                <div className={styles.progressRow}>
                  <div className={styles.progressTrack}>
                    <div className={styles.progressFill} style={{ width: `${pct}%` }} />
                  </div>
                  <span className={styles.progressLabel}>{pct}%</span>
                </div>

                {/*
                  progress.nextActionableId is an internal milestone *id*
                  (goals/advance.ts nextActionableMilestone(goal)?.id) — the
                  /api/goals handler only returns {title,status,order} per
                  milestone, with no id, so there is no reliable key to match
                  this against a specific list item below. Shown as its own
                  line instead of silently (and possibly wrongly) highlighting
                  a milestone by title collision.
                */}
                {goal.progress.nextActionableId ? (
                  <p className={styles.nextActionable}>
                    Next actionable milestone id: <span className={styles.mono}>{goal.progress.nextActionableId}</span>
                  </p>
                ) : null}

                {goal.milestones.length > 0 ? (
                  <ol className={styles.milestoneList}>
                    {[...goal.milestones]
                      .sort((a, b) => a.order - b.order)
                      .map((m) => (
                        <li key={m.title} className={styles.milestoneItem}>
                          <StatusBadge status={m.status} />
                          <span className={styles.milestoneTitle}>{m.title}</span>
                        </li>
                      ))}
                  </ol>
                ) : (
                  <p className={styles.noMilestones}>No milestones yet.</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
