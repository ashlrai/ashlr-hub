/**
 * components/charts/fleet-history-view.ts — maps the `GET /api/verse/fleet/history`
 * payload (core/verse/fleet-history-types.ts) onto the chart kit's props, so
 * every surface that charts fleet history (Command, Fleet, Growth) makes the
 * same honesty decisions:
 *
 *   - the fleet is DARK → every chart shows "Fleet dark since <date>", not
 *     empty axes;
 *   - a source could not be read at all → "unknown", not zeros;
 *   - a source was only partly read → a caveat naming why (lower bounds);
 *   - claim-check → always the not-recorded state, never a fabricated series.
 *
 * Pure functions over the wire type; no fetching here.
 */
import type {
  FleetHistoryDay,
  FleetHistoryResponse,
  FleetHistorySource,
} from '../../../core/verse/fleet-history-types.js';
import type { ChartStatus } from './ChartFrame.js';
import type { BarStackProps } from './BarStack.js';
import type { FunnelStage } from './Funnel.js';
import type { SwimlaneLane } from './Swimlane.js';
import type { CalendarDatum } from './CalendarHeatmap.js';
import type { AreaTrendSeries } from './AreaTrend.js';
import { toneColor } from './colors.js';
import { formatDayLabel } from './format.js';

const REASON_TEXT: Record<string, string> = {
  'oversized-file': 'some records are over the size bound',
  'invalid-file': 'some records are malformed',
  'unsafe-file': 'some records were refused (symlink, shared or foreign-owned)',
  'unsafe-directory': 'the store directory is not private',
  'io-error': 'some records could not be read',
  'file-limit': 'the store has more records than one read covers',
  'invalid-row': 'some ledger rows are malformed',
  'oversized-row': 'some ledger rows are over the size bound',
  'duplicate-canonical-realized-merge-identity': 'two proposals claim the same merge, so merges are unknown',
  'claim-integrity-verdicts-not-persisted': 'claim-check verdicts are not recorded per proposal yet',
  'scorecard-trend-pending': 'the scorecard trend is still being collected',
  'scorecard-worker-unavailable': 'the scorecard trend could not be read this time',
};

function reasonText(reason: string): string {
  return REASON_TEXT[reason] ?? reason.replace(/-/g, ' ');
}

/** A caveat sentence for a partly-read source, or undefined when it is complete. */
export function sourceCaveat(label: string, source: FleetHistorySource): string | undefined {
  if (source.complete || source.state === 'not-recorded') return undefined;
  if (source.reasons.length === 0) return undefined;
  const skipped = source.recordsSkipped > 0 ? ` (${source.recordsSkipped} skipped)` : '';
  return `${label} are lower bounds: ${source.reasons.map(reasonText).join('; ')}${skipped}.`;
}

/**
 * The shared status for a chart over one source. Order matters: unreadable
 * beats dark (we cannot claim darkness from a store we cannot read), and dark
 * beats an all-zero window (the designed "since" message is more useful).
 */
export function historyStatus(history: FleetHistoryResponse, source: FleetHistorySource): ChartStatus {
  if (source.state === 'not-recorded') return { kind: 'unknown', reason: `${reasonText(source.reasons[0] ?? 'not recorded')}.` };
  if (source.state === 'degraded' && source.recordsRead === 0) {
    return { kind: 'unknown', reason: `${reasonText(source.reasons[0] ?? 'io-error')}.` };
  }
  if (history.darkSince) return { kind: 'dark', since: history.darkSince };
  return { kind: 'ready' };
}

/** "Sep 3" for a day row (the wire's days are already in the caller's zone). */
export function dayLabel(day: FleetHistoryDay): string {
  return formatDayLabel(day.day);
}

/** Runs per day as done / failed / aborted / unfinished — status tones, legend-labelled. */
export function runsByDay(history: FleetHistoryResponse): Pick<BarStackProps, 'categories' | 'segments' | 'values' | 'status' | 'caveat'> {
  return {
    categories: history.days.map(dayLabel),
    segments: [
      { id: 'done', label: 'Done', color: toneColor('success') },
      { id: 'failed', label: 'Failed', color: toneColor('danger') },
      { id: 'aborted', label: 'Aborted', color: toneColor('neutral') },
      { id: 'unfinished', label: 'Unfinished', color: toneColor('running') },
    ],
    values: history.days.map((d) => [d.runs.done, d.runs.failed, d.runs.aborted, d.runs.unfinished]),
    status: historyStatus(history, history.sources.runs),
    caveat: sourceCaveat('Run counts', history.sources.runs),
  };
}

/** Judge verdicts per day (the considered ones, plus failed judge calls). */
export function verdictsByDay(history: FleetHistoryResponse): Pick<BarStackProps, 'categories' | 'segments' | 'values' | 'status' | 'caveat'> {
  return {
    categories: history.days.map(dayLabel),
    segments: [
      { id: 'ship', label: 'Ship', color: toneColor('success') },
      { id: 'review', label: 'Review', color: toneColor('warning') },
      { id: 'noise', label: 'Noise', color: toneColor('neutral') },
      { id: 'harmful', label: 'Harmful', color: toneColor('danger') },
      { id: 'failed', label: 'Judge failed', color: toneColor('unknown') },
    ],
    values: history.days.map((d) => [d.judged.ship, d.judged.review, d.judged.noise, d.judged.harmful, d.judged.failed]),
    status: historyStatus(history, history.sources.decisions),
    caveat: sourceCaveat('Verdict counts', history.sources.decisions),
  };
}

/** Proposal pipeline for the window (cumulative stages — see FleetHistoryFunnel). */
export function pipelineFunnel(history: FleetHistoryResponse): { stages: FunnelStage[]; status: ChartStatus; caveat?: string } {
  const f = history.funnel;
  const caveat = sourceCaveat('Pipeline counts', history.sources.proposals) ?? sourceCaveat('Pipeline counts', history.sources.decisions);
  return {
    stages: [
      { id: 'filed', label: 'Filed', value: f.filed },
      { id: 'verified', label: 'Verified', value: f.verified },
      { id: 'passed', label: 'Verification passed', value: f.verificationPassed },
      { id: 'ship', label: 'Judged ship', value: f.judgedShip },
      { id: 'merged', label: 'Merged', value: f.merged },
    ],
    status: historyStatus(history, history.sources.proposals),
    ...(caveat ? { caveat } : {}),
  };
}

/** Swimlane lanes straight from the projection (runs → bars, engine as detail). */
export function runLanes(history: FleetHistoryResponse): { lanes: SwimlaneLane[]; from: number; to: number; status: ChartStatus; caveat?: string } {
  const truncated = history.swimlanesTruncated ? 'Showing the newest runs only; the full list is longer.' : undefined;
  const caveat = [sourceCaveat('Runs', history.sources.runs), truncated].filter(Boolean).join(' ') || undefined;
  return {
    lanes: history.swimlanes.map((lane) => ({
      id: lane.id,
      label: lane.label,
      items: lane.items.map((item) => ({
        id: item.id,
        start: item.startMs,
        end: item.endMs,
        status: item.status,
        detail: item.engine,
        stale: item.stale,
      })),
    })),
    from: Date.parse(history.window.from),
    to: Date.parse(history.window.to),
    status: historyStatus(history, history.sources.runs),
    ...(caveat ? { caveat } : {}),
  };
}

/** One number per day for the calendar heatmap. */
export function dailyValues(history: FleetHistoryResponse, pick: (day: FleetHistoryDay) => number | null): CalendarDatum[] {
  return history.days.map((d) => ({ day: d.day, value: pick(d) }));
}

/** Scorecard trend (daily snapshots of the trailing window) as AreaTrend series. */
export function scorecardSeries(history: FleetHistoryResponse, window: '7d' | '30d' = '7d'): { series: AreaTrendSeries[]; status: ChartStatus; caveat?: string } {
  const points = window === '7d' ? history.scorecard.trend7d : history.scorecard.trend30d;
  const source = history.scorecard.source;
  const status: ChartStatus = points.length === 0
    ? source.state === 'degraded'
      ? { kind: 'unknown', reason: `${reasonText(source.reasons[0] ?? 'io-error')}.` }
      : { kind: 'empty', message: 'No scorecard snapshots yet — the first is taken today, then one a day.' }
    : { kind: 'ready' };
  const caveat = points.length > 0 ? sourceCaveat('Scorecard points', source) : undefined;
  return {
    series: [
      { id: 'merges', label: 'Merges', points: points.map((p) => ({ x: Date.parse(p.ts), y: p.merges.realized })) },
      { id: 'filed', label: 'Proposals filed', points: points.map((p) => ({ x: Date.parse(p.ts), y: p.proposalsFiled })) },
    ],
    status,
    ...(caveat ? { caveat } : {}),
  };
}
