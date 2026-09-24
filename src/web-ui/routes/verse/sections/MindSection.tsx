/**
 * routes/verse/sections/MindSection.tsx — ⌘4 Mind: what did the Leader
 * decide, and was it right? (SPEC-310B §6, SPEC-310C §5; unit C7)
 *
 *   Memo timeline with 7-day outcomes ✓/✗ and Veto (8) | Hit-rate gauge + standards (4)
 *   Three A7 insight cards                                               (12)
 *   Insight matrix kind × engine, per repo (8)          | Reasoning trends (4)
 *   Action log with Veto                                                 (12)
 *
 * At 375 px one column in that order, and the matrix starts on its table
 * (a 6 × 4 grid of 22 px cells says less than its table on a phone).
 */
import { useId, useMemo, useState } from 'react';
import { AreaTrend } from '../../../components/charts/AreaTrend.js';
import type { ChartStatus } from '../../../components/charts/ChartFrame.js';
import { MatrixHeatmap } from '../../../components/charts/MatrixHeatmap.js';
import { RefreshIndicator } from '../../../components/primitives/RefreshIndicator.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { ActionStatus, useSurfaceActions } from '../command/actions.js';
import { anchorId } from '../command/nav.js';
import { Card, Cell, Surface } from '../command/Surface.js';
import { leaderQuery, reasoningDigestQuery } from '../command/surface-data.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { useViewport } from '../shell/viewport.js';
import { ActionLog, HitRateCard, InsightCards, MemoTimeline } from '../mind/MindCards.js';
import { insightMatrix, insightRepos, reasoningTrendSeries, topInsights } from '../mind/mind-model.js';
import styles from '../mind/mind.module.css';

export const MIND_POLL_MS = 60_000;

export function MindSection() {
  const { compact } = useViewport();
  const leader = useQuery(leaderQuery);
  const digest = useQuery(reasoningDigestQuery, { freshMs: 60_000 });
  const refetchLeader = useRefetch(leaderQuery);
  const refetchDigest = useRefetch(reasoningDigestQuery);
  usePollWhileVisible(() => {
    refetchLeader();
    refetchDigest();
  }, MIND_POLL_MS);
  const actions = useSurfaceActions();
  const facetId = useId();

  const d = digest.data?.value ?? null;
  const repos = useMemo(() => insightRepos(d), [d]);
  const [repo, setRepo] = useState<string | null>(null);
  const facet = repo !== null && repos.includes(repo) ? repo : null;
  const matrix = useMemo(() => insightMatrix(d, facet), [d, facet]);
  const top = topInsights(d);
  const trends = reasoningTrendSeries(d);

  const digestStatus = (hasData: boolean, empty: string): ChartStatus =>
    !digest.data ? { kind: 'loading' } : !d ? { kind: 'unknown', reason: digest.data.reason ?? 'the reasoning digest did not answer.' } : hasData ? { kind: 'ready' } : { kind: 'empty', message: empty };
  const reasoned = d ? d.totals.steps > 0 : false;

  return (
    <Surface title="Mind" actions={[leader, digest].some((q) => q.status === 'refreshing') ? <RefreshIndicator /> : null} lead={<ActionStatus actions={actions} />}>
      <Cell span={8}>
        <MemoTimeline read={leader.data} actions={actions} />
      </Cell>
      <Cell span={4}>
        <HitRateCard read={leader.data} />
      </Cell>
      <Cell span={12}>
        <Card title="What the reasoning shows" caption={d ? `Last 30 days · ${d.totals.steps.toLocaleString('en-US')} reasoning steps across ${d.totals.sessions} sessions` : undefined}>
          <div id={anchorId('insights')}>
            <InsightCards insights={top} loading={!digest.data} reason={!digest.data || d ? null : (digest.data.reason ?? 'The reasoning digest did not answer.')} />
          </div>
        </Card>
      </Cell>
      <Cell span={8}>
        <MatrixHeatmap
          title="Insights by kind and engine"
          description={facet ? `In ${facet}` : 'All repos · 30 days'}
          status={digestStatus(reasoned && matrix.columns.length > 0, 'No reasoning was recorded in the last 30 days.')}
          rows={matrix.rows}
          columns={matrix.columns}
          values={matrix.values}
          unit="insights"
          defaultView={compact ? 'table' : 'chart'}
          actions={
            repos.length > 1 ? (
              <label className={styles.facet} htmlFor={facetId}>
                Repo
                <select id={facetId} value={facet ?? ''} onChange={(e) => setRepo(e.target.value || null)}>
                  <option value="">All</option>
                  {repos.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </label>
            ) : null
          }
        />
      </Cell>
      <Cell span={4}>
        <AreaTrend
          title="Struggles and wins"
          description="Per day · days with no reasoning are gaps"
          status={digestStatus(reasoned, 'No reasoning was recorded in the last 30 days.')}
          series={trends}
          height={200}
        />
      </Cell>
      <Cell span={12}>
        <ActionLog read={leader.data} actions={actions} />
      </Cell>
      {actions.dialogs}
    </Surface>
  );
}
