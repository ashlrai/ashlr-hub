import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { UniversePortfolioControllerView } from '../../core/web/universe-console-types.js';
import { UniverseControllerChanges } from './UniverseControllerChanges.js';

const observation = (): UniversePortfolioControllerView => ({
  schemaVersion: 1, controllerId: 'fleet', sourceState: 'healthy', status: 'incomplete',
  observedAt: '2026-09-09T10:00:00.000Z', createdAt: '2026-09-09T08:00:00.000Z', deadlineAt: '2026-09-10T08:00:00.000Z', reasons: [],
  outcomes: [{ campaignId: 'engine', state: 'pending', reasonCode: 'pending', attempted: false }],
  topology: [{ campaignId: 'engine', dependsOn: [], prerequisites: [] }],
});
const nextObservation = () => ({ ...observation(), observedAt: '2026-09-09T11:00:00.000Z' });

describe('controller observation changes', () => {
  it('shows baseline guidance and exact observation time without activity claims', () => {
    const { container } = render(<UniverseControllerChanges previous={null} current={observation()} historical={false} loading={false} />);
    const region = screen.getByRole('region', { name: 'Changes between observations' });
    expect(within(region).getByText('Refresh this controller to compare two observations.')).toBeInTheDocument();
    expect(screen.getByText('Not yet observed')).toBeInTheDocument();
    expect(container.querySelector('time')).toHaveAttribute('datetime', '2026-09-09T10:00:00.000Z');
    expect(container.querySelector('time')).toHaveTextContent('2026-09-09T10:00:00.000Z');
    expect(screen.getByText(/not an event log or a live activity view/)).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(container.querySelector('details')).not.toBeInTheDocument();
  });

  it('describes unchanged displayed evidence without claiming that no work occurred', () => {
    render(<UniverseControllerChanges previous={observation()} current={nextObservation()} historical={false} loading={false} />);
    expect(screen.getByText('No compared evidence fields changed. Observation times are excluded; this does not prove that no work occurred.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Observation change counts')).not.toBeInTheDocument();
    expect(screen.queryByText(/timestamps are equal or move backward/)).not.toBeInTheDocument();
    const times = within(screen.getByLabelText('Compared observation times'));
    expect(times.getByText('2026-09-09T10:00:00.000Z')).toBeInTheDocument();
    expect(times.getByText('2026-09-09T11:00:00.000Z')).toBeInTheDocument();
  });

  it('offers a focusable native disclosure of labeled before and after values', async () => {
    const previous = observation();
    const current = nextObservation();
    current.outcomes = [{ ...current.outcomes[0], state: 'held', reasonCode: 'dependency-held', attempted: true }];
    const { container } = render(<UniverseControllerChanges previous={previous} current={current} historical={false} loading={false} />);
    const counts = within(screen.getByLabelText('Observation change counts'));
    expect(counts.getByText('3')).toBeInTheDocument();
    expect(counts.getByText('1')).toBeInTheDocument();
    expect(counts.getByText('Changed fields')).toBeInTheDocument();
    expect(counts.getByText('Campaigns with displayed changes')).toBeInTheDocument();
    const summary = screen.getByText('Review 3 changed fields');
    expect(container.querySelector('details')).not.toHaveAttribute('open');
    summary.focus();
    expect(summary).toHaveFocus();
    // JSDOM does not implement summary's native Enter behavior; browser QA covers it.
    await userEvent.setup().click(summary);
    expect(container.querySelector('details')).toHaveAttribute('open');
    const rows = within(screen.getByRole('list', { name: 'Changed observation fields' })).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    const state = rows.find((row) => within(row).queryByRole('heading', { name: 'Recorded state' }))!;
    expect(within(state).getByText('engine')).toBeInTheDocument();
    expect(within(state).getByText('Before')).toBeInTheDocument();
    expect(within(state).getByText('After')).toBeInTheDocument();
    expect(within(state).getByText('Pending')).toBeInTheDocument();
    expect(within(state).getByText('Held')).toBeInTheDocument();
    expect(within(state).getAllByRole('definition')).toHaveLength(2);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByText(/do not establish worker execution/)).toBeInTheDocument();
  });

  it('marks retained comparisons historical and pending without changing their content', () => {
    const previous = observation();
    const current = nextObservation();
    current.outcomes = [{ ...current.outcomes[0], reasonCode: 'changed-reason' }];
    const { rerender } = render(<UniverseControllerChanges previous={previous} current={current} historical={false} loading={false} />);
    expect(screen.getByText('Review 1 changed field')).toBeInTheDocument();
    rerender(<UniverseControllerChanges previous={previous} current={current} historical loading />);
    expect(screen.getByText('Review 1 changed field')).toBeInTheDocument();
    expect(screen.getByText('Historical observations')).toBeInTheDocument();
    expect(screen.getByText('Refresh in progress')).toBeInTheDocument();
    expect(screen.getByText(/latest refresh failed/)).toBeInTheDocument();
    expect(screen.getByText(/remain unchanged while the refresh is pending/)).toBeInTheDocument();
    expect(screen.getByText('2026-09-09T11:00:00.000Z')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it.each(['controller', 'registration'] as const)('refuses comparison across a changed %s identity', (identity) => {
    const current = nextObservation();
    if (identity === 'controller') current.controllerId = 'other';
    else current.createdAt = '2026-09-09T09:00:00.000Z';
    render(<UniverseControllerChanges previous={observation()} current={current} historical={false} loading={false} />);
    expect(screen.getByText('These observations cannot be compared as one controller registration.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Observation change counts')).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Changed observation fields' })).not.toBeInTheDocument();
  });

  it.each(['2026-09-09T10:00:00.000Z', '2026-09-09T09:00:00.000Z'])('warns about nonincreasing observation clocks (%s)', (observedAt) => {
    render(<UniverseControllerChanges previous={observation()} current={{ ...nextObservation(), observedAt }} historical={false} loading={false} />);
    expect(screen.getByText('Observation timestamps are equal or move backward. Before and after follow response order, not a verified event timeline.')).toBeInTheDocument();
  });

  it.each(['degraded', 'missing'] as const)('retains the %s evidence caution when campaign presence differs', async (sourceState) => {
    const current = { ...nextObservation(), sourceState, outcomes: [], topology: [] };
    render(<UniverseControllerChanges previous={observation()} current={current} historical={false} loading={false} />);
    expect(screen.getByText(/One or both observations contain missing or degraded evidence/)).toBeInTheDocument();
    expect(screen.getByText(/Absence from an observation does not establish deletion, completion or execution/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByText(/Review .* changed fields/));
    const rows = within(screen.getByRole('list', { name: 'Changed observation fields' })).getAllByRole('listitem');
    const presence = rows.find((row) => within(row).queryByRole('heading', { name: 'Campaign presence' }))!;
    expect(within(presence).getByText('Present')).toBeInTheDocument();
    expect(within(presence).getByText('Not observed')).toBeInTheDocument();
  });

  it('renders changed evidence as text without network or browser storage access', async () => {
    const request = vi.spyOn(globalThis, 'fetch');
    const storageRead = vi.spyOn(Storage.prototype, 'getItem');
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
    const current = nextObservation();
    current.outcomes = [{ ...current.outcomes[0], reasonCode: '<img src=x onerror=alert(1)>' }];
    const { container } = render(<UniverseControllerChanges previous={observation()} current={current} historical={false} loading={false} />);
    await userEvent.setup().click(screen.getByText('Review 1 changed field'));
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(container.querySelector('img')).not.toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();
    expect(storageRead).not.toHaveBeenCalled();
    expect(storageWrite).not.toHaveBeenCalled();
    request.mockRestore(); storageRead.mockRestore(); storageWrite.mockRestore();
  });
});
