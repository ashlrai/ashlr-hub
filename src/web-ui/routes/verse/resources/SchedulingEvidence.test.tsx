import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { BudgetView } from '../../../../core/routing/policy.js';
import { FleetScheduling } from './SchedulingEvidence.js';

const budget: BudgetView = { mode: 'balanced', seats: {}, updatedAt: '', headroom: [], effective: {}, readingMaxAgeMs: 900_000, sampledAt: '',
  seatInfo: [{ seatId: 'grok', label: 'Work Grok', engine: 'grok', free: false }] };
describe('compact scheduling disclosure', () => {
  it('is an accessible collapsed read-only disclosure with explicit old-server evidence', () => {
    const { container, rerender } = render(<FleetScheduling budget={budget} now={Date.now()} />);
    const summary = screen.getByText('Capacity for work');
    const details = summary.closest('details')!;
    expect(details.open).toBe(false);
    fireEvent.click(summary);
    expect(details.open).toBe(true);
    const account = screen.getByRole('region', { name: 'Work capacity: Work Grok' });
    expect(within(account).getByText('Work capacity unavailable.')).toBeInTheDocument();
    expect(container.querySelector('button,input,select')).toBeNull();
    rerender(<FleetScheduling budget={null} now={Date.now()} />);
    expect(screen.getByText('Account scheduling evidence unavailable.')).toBeInTheDocument();
  });

  it('keeps account status and sampled duration visible while model and token provenance expands independently', () => {
    const now = Date.parse('2026-10-01T12:00:00.000Z');
    const value: BudgetView = { ...budget, seatInfo: Array.from({ length: 4 }, (_, index) => ({ seatId: `grok-${index}`, label: `Demo Grok ${index + 1}`, engine: 'grok', free: false })),
      scheduling: { sourceState: 'ready', observedAt: new Date(now).toISOString(), accounts: Array.from({ length: 4 }, (_, index) => ({
        seatId: `grok-${index}`, observedAt: new Date(now - 60_000).toISOString(), admission: 'eligible', headroomPercent: 24,
        reset: { kind: 'fixed-period', startsAt: new Date(now - 86_400_000).toISOString(), at: new Date(now + 3_600_000).toISOString(), source: 'grok-native-billing', description: null },
        opportunity: { kind: 'before-reset', reason: 'fixed-period-eligible' }, forecast: { taskId: 'demo-recorded', recordedAt: new Date(now - 300_000).toISOString(),
          durationMs: { p25: 60_000, p50: 120_000, p75: 180_000, samples: 7 }, tokens: { p25: 1200, p50: 1800, p75: 2400, samples: 3 },
          cohort: { engine: 'grok-cli', model: 'grok-code', seatId: null, taskKind: 'code' }, fit: 'likely-before-reset', limitations: [] } })) } };
    const { container, rerender } = render(<FleetScheduling budget={value} now={now} />);
    fireEvent.click(screen.getByText('Capacity for work'));
    expect(screen.getAllByRole('region', { name: /Work capacity: Demo Grok/ })).toHaveLength(4);
    const card = screen.getByRole('region', { name: 'Work capacity: Demo Grok 1' });
    expect(within(card).getByText('24% available after your reserve.')).toBeInTheDocument();
    expect(within(card).getByText('Allowance resets in 1h 00m.')).toBeInTheDocument();
    const duration = within(card).getByText(/Middle half of observed durations.*7 samples/);
    expect(duration.closest('details')).toBe(screen.getByText('Capacity for work').closest('details'));
    expect(within(card).getByText(/Last selected task.*Not the current task or model/)).toBeInTheDocument();
    expect(within(card).getByText('Historical estimates, not a completion guarantee.')).toBeInTheDocument();
    const summary = within(card).getByText('Model, tokens & evidence');
    expect(summary.closest('details')!.open).toBe(false);
    summary.focus(); expect(summary).toHaveFocus();
    fireEvent.click(summary); expect(summary.closest('details')!.open).toBe(true);
    expect(within(card).getByText(/recorded model grok-code/)).toBeInTheDocument();
    expect(within(card).getByText(/1,200–2,400.*3 samples; not remaining account tokens/)).toBeInTheDocument();
    expect(within(card).getByText(/pooled across accounts; account attribution unavailable/)).toBeInTheDocument();
    expect(container.querySelector('button,input,select')).toBeNull();
    rerender(<FleetScheduling budget={value} now={now + 1000} />);
    expect(summary.closest('details')!.open).toBe(true);
  });
});
