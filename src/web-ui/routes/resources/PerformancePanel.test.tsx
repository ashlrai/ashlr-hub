import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { buildResourcePerformance } from '../../../core/resources/performance.js';
import { PerformancePanel, executionTime, usageScopeLabel } from './PerformancePanel.js';
import { resourceFixture } from './fixtures.test-support.js';

function report() {
  const { snapshot } = resourceFixture();
  const pool = { schemaVersion: 1 as const, ...snapshot.pool, workers: snapshot.pool.workers.map(({ capacityKey: _key, ...worker }) => worker) };
  const attempts = [...snapshot.activeAttempts, ...snapshot.recentAttempts];
  attempts[2]!.execution = { schemaVersion: 1, scope: 'worker-execution', durationMs: 1_234, usageScope: 'local-chat-completion' };
  return buildResourcePerformance(pool, attempts);
}
describe('worker performance presentation', () => {
  it('shows unknown legacy evidence rather than fabricated statistics', () => {
    render(<PerformancePanel report={undefined} onSelect={() => {}} />);
    expect(screen.getByText(/Performance evidence is unavailable/)).toBeVisible();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
  it('shows measured per-outcome samples and named token scope without ranking quality', () => {
    const select = vi.fn(); render(<PerformancePanel report={report()} onSelect={select} />);
    const row = screen.getByRole('button', { name: 'local-a' }).closest('tr')!;
    expect(within(row).getAllByText('1.2 s')).toHaveLength(2);
    expect(within(row).getByText('Local chat completion: 1 reported')).toBeVisible();
    expect(within(row).getByText('1 reported / 1 unknown')).toBeVisible();
    expect(screen.getByText(/Quality and accepted engineering yield remain unmeasured/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'local-a' })); expect(select).toHaveBeenCalledWith('local-a');
  });
  it('switches exact outcome cohorts and preserves unknown timing', () => {
    render(<PerformancePanel report={report()} onSelect={() => {}} />);
    fireEvent.change(screen.getByLabelText('Performance outcome'), { target: { value: 'uncertain' } });
    const row = screen.getByRole('button', { name: 'codex-a' }).closest('tr')!;
    expect(within(row).getByText('0 / 1')).toBeVisible(); expect(within(row).getByText('1 unmeasured')).toBeVisible();
    expect(within(row).getAllByText('Not measured')).toHaveLength(2);
  });
  it('keeps genuine zero duration distinct from missing and clarifies Claude scope', () => {
    expect(executionTime(0)).toBe('0 ms'); expect(executionTime(null)).toBe('Not measured');
    expect(usageScopeLabel('claude-main-loop')).toContain('excludes subagents'); expect(usageScopeLabel(null)).toBe('Scope not recorded');
  });
});
