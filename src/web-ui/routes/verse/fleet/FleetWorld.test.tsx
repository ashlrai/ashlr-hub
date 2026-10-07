import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { fleetLive } from '../command/fixtures.test-support.js';
import FleetWorld from './FleetWorld.js';

const snapshot = () => fleetLive('live', Date.parse('2026-10-06T20:00:00Z'));

describe('Fleet world recorded identity', () => {
  it('labels a retained snapshot after a failed refresh and does not spin on a failed first read', () => {
    const { rerender } = render(<FleetWorld read={undefined} readFailed />);
    expect(screen.getByRole('status')).toHaveTextContent('Fleet data could not be read.');
    rerender(<FleetWorld read={{ value: snapshot(), available: true, reason: null }} readFailed />);
    expect(screen.getByRole('status')).toHaveTextContent('Last recorded snapshot · refresh failed.');
    expect(screen.getAllByRole('button').length).toBeGreaterThan(0);
  });
  it('keeps the selected run through reordering, updates its outcome, and never substitutes a vanished run', () => {
    const live = snapshot();
    const run = live.runs[0]!;
    const read = { value: live, available: true, reason: null };
    const { rerender } = render(<FleetWorld read={read} />);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(run.title) }));
    const inspector = screen.getByRole('complementary', { name: 'Selected fleet task' });
    expect(within(inspector).getByRole('heading', { name: run.title })).toBeInTheDocument();
    const updated = { ...live, runs: [...live.runs].reverse().map(item => item.id === run.id ? { ...item, outcome: 'proposed' as const } : item) };
    rerender(<FleetWorld read={{ ...read, value: updated }} />);
    expect(within(inspector).getAllByText('proposed').length).toBeGreaterThan(0);
    rerender(<FleetWorld read={{ ...read, value: { ...live, runs: live.runs.filter(item => item.id !== run.id) } }} />);
    expect(within(inspector).getByText(/no longer in the current snapshot/)).toBeInTheDocument();
    expect(within(inspector).queryByRole('heading')).not.toBeInTheDocument();
  });

  it('filters the world without losing an inspected identity and does not fabricate missing resource or model data', () => {
    const live = snapshot();
    const run = { ...live.runs[0]!, engine: null, lane: null, model: null, seatId: null };
    render(<FleetWorld read={{ value: { ...live, runs: [run] }, available: true, reason: null }} />);
    const button = screen.getByRole('button', { name: new RegExp(run.title) });
    button.focus();
    expect(button).toHaveFocus();
    fireEvent.click(button);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'no-such-repository' } });
    expect(screen.getByText('No tasks match your search.')).toBeInTheDocument();
    const inspector = screen.getByRole('complementary', { name: 'Selected fleet task' });
    expect(within(inspector).getByRole('heading', { name: run.title })).toBeInTheDocument();
    expect(within(inspector).getAllByText('Not reported')).toHaveLength(3);
  });

  it('shows unavailable data separately from an idle empty fleet', () => {
    const { rerender } = render(<FleetWorld read={{ value: null, available: false, reason: 'The fleet could not be read.' }} />);
    expect(screen.getByRole('status')).toHaveTextContent('The fleet could not be read.');
    const live = { ...snapshot(), state: 'paused' as const, stateReason: 'Paused by you', runs: [] };
    rerender(<FleetWorld read={{ value: live, available: true, reason: null }} />);
    expect(screen.getByText('No recorded runs in the current window.')).toBeInTheDocument();
    expect(screen.getByText('Paused by you')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText(/collaboration links are not recorded/)).toBeInTheDocument();
  });
});
