/**
 * routes/verse/sections/GrowthSection.tsx — ⌘3 Growth: is the output
 * compounding? (SPEC-310B §6, SPEC-310C §5; unit C7)
 *
 *   Merges / week (8)                        | Cost per merge (4)
 *   Pipeline funnel (4) | Model outcomes (4) | Merges by day (4)
 *   Harness level with 95% band + ▼ rollbacks (8) | Experiments forest plot (4)
 *
 * Sources: fleet history (A8), per-model economics (/api/models), learning
 * (B-U9). Each can be missing on its own; its cards say so. History and
 * learning change daily, so the surface refreshes every 5 minutes while
 * visible — never faster.
 *
 * Dormant fleet: when autonomy is off (or on but quiet) the shared
 * AutonomyOffState leads the grid. When history is also quiet (nothing
 * produced for 48 h), every history card would repeat the same "since" date,
 * so those five are left out, and the learning / model cards stay only if
 * they have something real to draw — one clear state instead of six
 * identical empty cards.
 */
import { useMemo } from 'react';
import { AreaTrend } from '../../../components/charts/AreaTrend.js';
import { BarStack } from '../../../components/charts/BarStack.js';
import { CalendarHeatmap } from '../../../components/charts/CalendarHeatmap.js';
import type { ChartStatus } from '../../../components/charts/ChartFrame.js';
import { CHART_SEQUENTIAL } from '../../../components/charts/colors.js';
import { ForestPlot } from '../../../components/charts/ForestPlot.js';
import { Funnel } from '../../../components/charts/Funnel.js';
import { StepBand } from '../../../components/charts/StepBand.js';
import { dailyValues, historyStatus, pipelineFunnel, sourceCaveat } from '../../../components/charts/fleet-history-view.js';
import { formatTimeLabel, formatUsd } from '../../../components/charts/format.js';
import { RefreshIndicator } from '../../../components/primitives/RefreshIndicator.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { AutonomyOffState, useAutonomyOff } from '../autonomy/AutonomyOffState.js';
import { modelsQuery } from '../../../data/queries.js';
import { useNow } from '../autonomy/use-ticker.js';
import { Cell, Surface } from '../command/Surface.js';
import { fleetHistoryQuery, learningQuery } from '../command/surface-data.js';
import { quietSinceStatus } from '../fleet/dark-since.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { OUTCOME_SEGMENTS, costPerMerge, forestRows, harnessSteps, modelOutcomes, weeklyBins } from '../growth/growth-model.js';
import { HARNESS_ADOPTION_GATE } from '../../../../core/learn/harness-types.js';

export const GROWTH_POLL_MS = 300_000;

const models30 = modelsQuery('30d');

function unknownFrom(reason: string | null | undefined, fallback: string): ChartStatus {
  return { kind: 'unknown', reason: reason ?? fallback };
}

export function GrowthSection() {
  const history = useQuery(fleetHistoryQuery, { freshMs: 60_000 });
  const learning = useQuery(learningQuery, { freshMs: 60_000 });
  const models = useQuery(models30, { freshMs: 60_000 });
  const refetchHistory = useRefetch(fleetHistoryQuery);
  const refetchLearning = useRefetch(learningQuery);
  const refetchModels = useRefetch(models30);
  usePollWhileVisible(() => {
    refetchHistory();
    refetchLearning();
    refetchModels();
  }, GROWTH_POLL_MS);
  const now = useNow(60_000);

  const hist = history.data?.value ?? null;
  const learn = learning.data?.value ?? null;

  const bins = useMemo(() => (hist ? weeklyBins(hist.days) : []), [hist]);
  const histStatus: ChartStatus = !history.data ? { kind: 'loading' } : !hist ? unknownFrom(history.data.reason, 'fleet history did not answer.') : quietSinceStatus(historyStatus(hist, hist.sources.runs));
  const weeklyStatus: ChartStatus = histStatus.kind !== 'ready' ? histStatus : bins.length === 0 ? { kind: 'empty', message: 'Less than a week of history.' } : { kind: 'ready' };
  const mergesCaveat = hist ? sourceCaveat('Merge counts', hist.sources.decisions) : undefined;
  const funnel = hist ? pipelineFunnel(hist) : null;

  const outcomes = useMemo(() => modelOutcomes(models.data?.models ?? []), [models.data]);
  const modelStatus: ChartStatus = models.status === 'loading'
    ? { kind: 'loading' }
    : models.status === 'error' || !models.data
      ? { kind: 'unknown', reason: 'per-model economics could not be read.' }
      : outcomes.categories.length === 0
        ? { kind: 'empty', message: 'No fleet dispatches in 30 days.' }
        : { kind: 'ready' };

  const harness = useMemo(() => harnessSteps(learn), [learn]);
  const forest = useMemo(() => forestRows(learn), [learn]);
  const learnStatus = (emptyMessage: string, hasData: boolean): ChartStatus =>
    !learning.data ? { kind: 'loading' } : !learn ? unknownFrom(learning.data.reason, 'self-improvement did not answer.') : hasData ? { kind: 'ready' } : { kind: 'empty', message: emptyMessage };

  // History's "quiet since" (48 h without a run or proposal). The shared
  // state decides what is off and why; undefined until its reads answer.
  const quietSince = hist?.darkSince ?? null;
  const off = useAutonomyOff(quietSince);
  // Collapse only once the state can explain it — never six blank cells.
  const dormant = quietSince !== null && off != null;
  // A defaults-only harness is a flat line at 0: nothing to show while dormant.
  const harnessMoved = harness.steps.length > 1 || harness.markers.length > 0;
  const keepModels = !dormant || modelStatus.kind === 'ready';
  const keepHarness = !dormant || harnessMoved;
  const keepExperiments = !dormant || forest.length > 0;
  // Nothing left to draw: the state is the whole surface, and says so first.
  const onlyState = dormant && modelStatus.kind !== 'ready' && !harnessMoved && forest.length === 0;

  // A week bin sits at its last day's LOCAL midnight (growth-model
  // `weeklyBins`), so this label and the chart's own fallback rung (the
  // local `formatTimeLabel`) name the same calendar day in every zone.
  const weekLabel = (ms: number) => `wk to ${formatTimeLabel(ms)}`;

  return (
    <Surface title="Growth" actions={[history, learning].some((q) => q.status === 'refreshing') ? <RefreshIndicator /> : null}>
      {off ? (
        <Cell span={12}>
          <AutonomyOffState state={off} here="growth" title={onlyState ? 'Growth starts with the first fleet run.' : undefined} />
        </Cell>
      ) : null}
      {dormant ? null : (
        <Cell span={8}>
          <AreaTrend
            title="Merges per week"
            description="Rolling 7-day windows ending today"
            caveat={mergesCaveat}
            status={weeklyStatus}
            series={[{ id: 'merges', label: 'Merges', color: CHART_SEQUENTIAL, points: bins.map((b) => ({ x: b.end, y: b.merges })) }]}
            formatX={weekLabel}
          />
        </Cell>
      )}
      {dormant ? null : (
        <Cell span={4}>
          <AreaTrend
            title="Cost per merge"
            description="Estimated run spend ÷ merges, per week"
            status={weeklyStatus}
            series={[{ id: 'cpm', label: 'Cost per merge', color: CHART_SEQUENTIAL, points: bins.map((b) => ({ x: b.end, y: costPerMerge(b) })) }]}
            formatX={weekLabel}
            formatY={formatUsd}
            height={200}
          />
        </Cell>
      )}
      {dormant ? null : (
        <Cell span={4}>
          <Funnel
            title="Pipeline · 90d"
            description="Filed → verified → passed → judged ship → merged"
            caveat={funnel?.caveat}
            status={!funnel ? histStatus : quietSinceStatus(funnel.status)}
            stages={funnel?.stages ?? []}
          />
        </Cell>
      )}
      {keepModels ? (
        <Cell span={4}>
          <BarStack
            title="Model outcomes · 30d"
            description="What each model's dispatches became"
            status={modelStatus}
            categories={outcomes.categories}
            categoryTitles={outcomes.titles}
            segments={OUTCOME_SEGMENTS}
            values={outcomes.values}
            height={200}
          />
        </Cell>
      ) : null}
      {dormant ? null : (
        <Cell span={4}>
          <CalendarHeatmap
            title="Merges by day"
            description="Last 90 days"
            status={histStatus}
            days={hist ? dailyValues(hist, (d) => d.merges.realized) : []}
            unit="merges"
          />
        </Cell>
      )}
      {keepHarness ? (
        <Cell span={8}>
          {/* The rules live in the tooltip; the card says what it plots. */}
          <div title={`Band = each step's own 95% interval. A new harness runs as a canary for ${HARNESS_ADOPTION_GATE.canaryHours} h first.`}>
            <StepBand
              title="Harness level"
              description="Pass-rate lift vs defaults"
              status={learnStatus('Compiled defaults in force.', harness.steps.length > 0)}
              steps={harness.steps}
              markers={harness.markers}
              now={now}
              baseline={{ value: 0, label: 'Compiled defaults' }}
              unit="pts"
            />
          </div>
        </Cell>
      ) : null}
      {keepExperiments ? (
        <Cell span={4}>
          <div title={`Adopted only when the interval's low end is above ${HARNESS_ADOPTION_GATE.minLiftCiLow}, over at least ${HARNESS_ADOPTION_GATE.minPairs} pairs.`}>
            <ForestPlot
              title="Experiments"
              description="Paired lift, 95% interval"
              status={learnStatus('No experiments yet.', forest.length > 0)}
              rows={forest}
              unit="pts"
              unknownText={`under ${HARNESS_ADOPTION_GATE.minPairs} pairs`}
            />
          </div>
        </Cell>
      ) : null}
    </Surface>
  );
}
