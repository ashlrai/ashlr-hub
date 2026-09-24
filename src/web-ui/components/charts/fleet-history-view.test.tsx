import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { FleetHistoryDay, FleetHistoryResponse, FleetHistorySource } from '../../../core/verse/fleet-history-types.js';
import { BarStack } from './BarStack.js';
import { Funnel } from './Funnel.js';
import { historyStatus, pipelineFunnel, runLanes, runsByDay, scorecardSeries, sourceCaveat, verdictsByDay, dailyValues } from './fleet-history-view.js';

const healthy: FleetHistorySource = { state: 'healthy', complete: true, reasons: [], recordsRead: 10, recordsSkipped: 0, lastRecordAt: null };

function day(d: string, runs: Partial<FleetHistoryDay['runs']> = {}): FleetHistoryDay {
  return {
    day: d,
    runs: { started: 0, done: 0, failed: 0, aborted: 0, unfinished: 0, ...runs },
    proposals: { filed: 0, withDiff: 0 },
    judged: { total: 0, ship: 0, review: 0, noise: 0, harmful: 0, failed: 0 },
    verification: { passed: 0, failedCode: 0, failedInfra: 0, failedUnknown: 0, withTests: 0 },
    merges: { realized: 0 },
    claimCheck: { passed: null, flagged: null },
    estCostUsd: 0,
  };
}

function history(overrides: Partial<FleetHistoryResponse> = {}): FleetHistoryResponse {
  return {
    generatedAt: '2026-09-23T15:00:00.000Z',
    window: { from: '2026-09-22T00:00:00.000Z', to: '2026-09-23T15:00:00.000Z', days: 2, tzOffsetMinutes: 0 },
    days: [day('2026-09-22', { started: 3, done: 2, failed: 1 }), day('2026-09-23')],
    totals: { runsStarted: 3, proposalsFiled: 0, judged: 0, verificationPassed: 0, mergesRealized: 0, estCostUsd: 0 },
    funnel: { filed: 10, verified: 4, verificationPassed: 2, judgedShip: 1, merged: null },
    swimlanes: [{ id: 'alpha', label: 'alpha', items: [{ id: 'r1', startMs: 1, endMs: null, status: 'running', engine: 'claude', stale: true }] }],
    swimlanesTruncated: true,
    lastActivityAt: '2026-09-22T10:00:00.000Z',
    darkSince: null,
    sources: {
      runs: healthy,
      proposals: healthy,
      decisions: healthy,
      claimCheck: { state: 'not-recorded', complete: false, reasons: ['claim-integrity-verdicts-not-persisted'], recordsRead: 0, recordsSkipped: 0, lastRecordAt: null },
    },
    scorecard: {
      trend7d: [], trend30d: [],
      source: { ...healthy, state: 'missing', recordsRead: 0 },
      snapshot: { mode: 'worker', lastAttemptAt: null, lastWroteAt: null },
    },
    ...overrides,
  };
}

describe('fleet-history-view', () => {
  it('maps runs per day onto status-toned stacked columns', () => {
    const props = runsByDay(history());
    expect(props.categories).toEqual(['Sep 22', 'Sep 23']);
    expect(props.values[0]).toEqual([2, 1, 0, 0]);
    expect(props.status).toEqual({ kind: 'ready' });
    render(<BarStack title="Runs per day" width={400} {...props} />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('Highest: Sep 22 with 3.');
  });

  it('shows the designed dark state when the fleet is dark', () => {
    const props = runsByDay(history({ darkSince: '2026-09-01T19:10:00.000Z' }));
    render(<BarStack title="Runs per day" {...props} />);
    expect(screen.getByText('Fleet dark since Sep 1')).toBeInTheDocument();
  });

  it('prefers unknown over dark when the store could not be read', () => {
    const unreadable: FleetHistorySource = { ...healthy, state: 'degraded', complete: false, reasons: ['unsafe-directory'], recordsRead: 0 };
    expect(historyStatus(history({ darkSince: '2026-09-01T00:00:00Z' }), unreadable)).toEqual({
      kind: 'unknown', reason: 'the store directory is not private.',
    });
  });

  it('writes lower-bound caveats in words', () => {
    const partial: FleetHistorySource = { ...healthy, state: 'degraded', complete: false, reasons: ['oversized-file'], recordsSkipped: 6 };
    expect(sourceCaveat('Run counts', partial)).toBe('Run counts are lower bounds: some records are over the size bound (6 skipped).');
    expect(sourceCaveat('Run counts', healthy)).toBeUndefined();
  });

  it('keeps unknown funnel stages unknown', () => {
    const { stages, status } = pipelineFunnel(history());
    render(<Funnel title="Pipeline" width={600} stages={stages} status={status} />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('Merged unknown');
  });

  it('maps swimlanes and flags truncation', () => {
    const lanes = runLanes(history());
    expect(lanes.lanes[0]!.items[0]).toEqual({ id: 'r1', start: 1, end: null, status: 'running', detail: 'claude', stale: true });
    expect(lanes.caveat).toBe('Showing the newest runs only; the full list is longer.');
  });

  it('explains an empty scorecard trend instead of drawing nothing', () => {
    expect(scorecardSeries(history()).status).toEqual({
      kind: 'empty', message: 'No scorecard snapshots yet — the first is taken today, then one a day.',
    });
  });

  it('maps verdicts and daily values', () => {
    expect(verdictsByDay(history()).segments.map((s) => s.id)).toEqual(['ship', 'review', 'noise', 'harmful', 'failed']);
    expect(dailyValues(history(), (d) => d.runs.started)).toEqual([{ day: '2026-09-22', value: 3 }, { day: '2026-09-23', value: 0 }]);
  });
});
