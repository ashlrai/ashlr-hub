import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ResourceConsoleSnapshot } from '../../../core/resources/console-types.js';
import { QuotaRefreshPanel } from './QuotaRefreshPanel.js';
import { resourceTime } from './CapacityBoard.js';

type Snapshot = NonNullable<ResourceConsoleSnapshot['quotaRefresh']>;
type Row = Snapshot['workers'][number];
const NOW = '2026-09-07T12:00:00.000Z';
const NEXT = '2026-09-07T12:00:30.000Z';
function snapshot(rows: Array<Partial<Row>> = [{}]): Snapshot {
  return { schemaVersion: 1, scope: 'codex-native-metadata', state: 'running', sampledAt: NOW,
    workers: rows.map((patch, index) => ({ workerId: `codex-${index + 1}`, status: 'pending',
      reason: 'managed-quota-pending', lastAttemptAt: null, lastSuccessAt: null, nextAttemptAt: NOW, ...patch })) };
}

describe('native quota collection presentation', () => {
  it.each([undefined, null])('omits unconfigured collectors %#', (refresh) => {
    const { container } = render(<QuotaRefreshPanel refresh={refresh} onSelect={() => {}} />);
    expect(container).toBeEmptyDOMElement(); expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows pending reads and absent successful samples without implying readiness', () => {
    render(<QuotaRefreshPanel refresh={snapshot()} onSelect={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Native quota reads' })).toBeVisible();
    expect(screen.getByText('Pending')).toBeVisible();
    expect(screen.getByText('No successful sample')).toBeVisible();
    expect(screen.getByText(/does not prove independent accounts or readiness to execute/)).toBeVisible();
    expect(screen.getByText(/Every enrolled alias in shared capacity/)).toBeVisible();
    expect(screen.getByRole('region', { name: 'Native quota read status' })).toHaveAttribute('tabindex', '0');
  });

  it('shows exact per-worker sample and retry times and opens the existing inspector', () => {
    const select = vi.fn();
    render(<QuotaRefreshPanel refresh={snapshot([{ workerId: 'codex-main', status: 'observed', reason: 'managed-quota-observed',
      lastAttemptAt: NOW, lastSuccessAt: NOW, nextAttemptAt: NEXT }])} selectedWorkerId="codex-main" onSelect={select} />);
    const button = screen.getByRole('button', { name: 'codex-main' });
    const row = button.closest('tr')!;
    expect(within(row).getByText('Observed')).toBeVisible();
    expect(within(row).getByText(resourceTime(NOW))).toBeVisible();
    expect(within(row).getByText(`Last attempt: ${resourceTime(NOW)}`)).toBeVisible();
    expect(within(row).getByText(resourceTime(NEXT))).toBeVisible();
    expect(button).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(button); expect(select).toHaveBeenCalledExactlyOnceWith('codex-main');
    expect(screen.queryByRole('button', { name: /refresh/i })).not.toBeInTheDocument();
  });

  it.each([
    ['refreshing', 'Refreshing'], ['failed', 'Failed'], ['timed-out', 'Timed out'],
    ['cancelled', 'Cancelled'], ['expired', 'Expired'], ['uncertain', 'Uncertain'], ['closed', 'Closed'],
  ] as const)('shows %s separately from a previously successful sample', (status, label) => {
    const refresh = snapshot([{ status, reason: `managed-quota-${status}`, lastSuccessAt: NOW, nextAttemptAt: null }]);
    if (status === 'closed') refresh.state = 'closed';
    render(<QuotaRefreshPanel refresh={refresh} onSelect={() => {}} />);
    expect(screen.getByText(label)).toBeVisible();
    expect(screen.getByText(resourceTime(NOW))).toBeVisible();
    expect(screen.getByText(status === 'refreshing' ? 'Read in progress' : 'Not scheduled')).toBeVisible();
    if (status === 'uncertain') expect(screen.getByText(/Native process cleanup is unconfirmed/)).toBeVisible();
    if (status === 'closed') expect(screen.getByText(/Collector stopped/)).toBeVisible();
  });

  it('distinguishes received metadata from known quota', () => {
    render(<QuotaRefreshPanel refresh={snapshot([{ status: 'observed', reason: 'managed-quota-unknown', lastSuccessAt: NOW }])}
      onSelect={() => {}} />);
    expect(screen.getByText('Observed; quota unknown')).toBeVisible();
    expect(screen.getByText('A quota percentage or reset is unknown. Admission is withheld.')).toBeVisible();
    expect(screen.queryByText(/0%|100%|ready to execute/i)).not.toBeInTheDocument();
  });

  it('does not render account hints, email, paths, commands or raw failure text', () => {
    const refresh = snapshot([{ status: 'failed', reason: 'PRIVATE_ERROR /private/auth fixture@example.invalid' }]);
    Object.assign(refresh, { accountHint: 'a'.repeat(64), command: '/private/native-wrapper', endpoint: 'http://private.invalid' });
    Object.assign(refresh.workers[0]!, { email: 'fixture@example.invalid', root: '/private/account-data' });
    const { container } = render(<QuotaRefreshPanel refresh={refresh} onSelect={() => {}} />);
    expect(screen.getByText('Metadata status details are unavailable.')).toBeVisible();
    for (const privateValue of ['PRIVATE_ERROR', '/private/', 'fixture@example.invalid', 'a'.repeat(64), 'http://private.invalid']) {
      expect(container.innerHTML).not.toContain(privateValue);
    }
  });

  it('distinguishes observed quota from exhausted admission', () => {
    render(<QuotaRefreshPanel refresh={snapshot([{ status: 'observed', reason: 'managed-quota-reserve-reached' }])} onSelect={() => {}} />);
    expect(screen.getByText('Observed; reserve reached')).toBeVisible();
    expect(screen.getByText(/A native quota window reached its configured reserve/)).toBeVisible();
  });

  it('uses a bounded unknown label for unrecognized status without echoing it', () => {
    const refresh = snapshot();
    Object.assign(refresh.workers[0]!, { status: 'PRIVATE_FUTURE_STATUS', reason: '__proto__', nextAttemptAt: null });
    const { container } = render(<QuotaRefreshPanel refresh={refresh} onSelect={() => {}} />);
    expect(screen.getByText('Unknown')).toBeVisible();
    expect(container.innerHTML).not.toContain('PRIVATE_FUTURE_STATUS');
  });
});
