import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ResourceConsoleSnapshot } from '../../../core/resources/console-types.js';
import { RESOURCE_COLLECTOR_RECOVERY_REASONS, RESOURCE_COLLECTOR_RECOVERY_MARKER_VERSIONS } from '../../../core/resources/console-types.js';
import { QuotaRefreshPanel } from './QuotaRefreshPanel.js';
import { resourceTime } from './CapacityBoard.js';
import badgeStyles from '../../components/primitives/StatusBadge.module.css';

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
  it.each(RESOURCE_COLLECTOR_RECOVERY_REASONS)('shows fixed sampled recovery guidance for %s', (reasonCode) => {
    render(<QuotaRefreshPanel refresh={undefined} collector={{ state: 'blocked', reasonCode: 'reconciliation-required', sampledAt: NOW,
      recovery: { reasonCode, markerVersion: RESOURCE_COLLECTOR_RECOVERY_MARKER_VERSIONS[reasonCode][0] } }} onSelect={() => {}} />);
    expect(screen.getByRole('heading', { name: /Sampled diagnosis:/ })).toBeVisible();
    const guidance = screen.getByText('What to do next');
    fireEvent.click(guidance);
    expect(screen.getByText(/not current process health or permission to clear evidence/)).toBeVisible();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
  it('explains why restarting cannot recover the current legacy format', () => {
    render(<QuotaRefreshPanel refresh={undefined} collector={{ state: 'blocked', reasonCode: 'reconciliation-required', sampledAt: NOW,
      recovery: { reasonCode: 'legacy-owner-evidence-missing', markerVersion: 1 } }} onSelect={() => {}} />);
    fireEvent.click(screen.getByText('What to do next'));
    expect(screen.getByText(/Restarting this console or the computer alone cannot/)).toBeVisible();
  });
  it('labels historical diagnosis and guidance without presenting it as a current check', () => {
    render(<QuotaRefreshPanel historical refresh={undefined} collector={{ state: 'blocked', reasonCode: 'reconciliation-required', sampledAt: NOW,
      recovery: { reasonCode: 'command-registration-incomplete', markerVersion: 4 } }} onSelect={() => {}} />);
    expect(screen.getByRole('heading', { name: /Last reported diagnosis:/ })).toBeVisible();
    expect(screen.getByText('Guidance for that recorded condition')).toBeVisible();
    expect(screen.queryByText('What to do next')).not.toBeInTheDocument();
  });
  it('does not echo unknown recovery fields or private values', () => {
    const recovery = { reasonCode: 'PRIVATE_REASON', markerVersion: '/PRIVATE/path' } as never;
    const { container } = render(<QuotaRefreshPanel refresh={undefined} collector={{ state: 'blocked', reasonCode: 'reconciliation-required', sampledAt: NOW, recovery }} onSelect={() => {}} />);
    expect(container.textContent).not.toContain('PRIVATE');
    expect(screen.queryByText('What to do next')).not.toBeInTheDocument();
  });
  it('suppresses contradictory diagnosis when passed directly to the view', () => {
    render(<QuotaRefreshPanel refresh={undefined} collector={{ state: 'blocked', reasonCode: 'reconciliation-required', sampledAt: NOW,
      recovery: { reasonCode: 'legacy-owner-evidence-missing', markerVersion: 4 } }} onSelect={() => {}} />);
    expect(screen.queryByRole('heading', { name: /Legacy record/ })).not.toBeInTheDocument();
    expect(screen.queryByText('What to do next')).not.toBeInTheDocument();
  });
  it.each(['collector-owned', 'reconciliation-required', 'collector-unavailable'] as const)(
    'shows configured-but-blocked %s without inventing native samples or retry controls', (reasonCode) => {
      render(<QuotaRefreshPanel refresh={undefined} collector={{ state: 'blocked', reasonCode, sampledAt: NOW }} onSelect={() => {}} />);
      expect(screen.getByRole('heading', { name: 'Native metadata collection' })).toBeVisible();
      expect(screen.getByText('Collection blocked')).toBeVisible();
      expect(screen.getByText(/configured monitoring is not a successful sample/)).toBeVisible();
      expect(screen.getByText(/There is no automatic retry/)).toBeVisible();
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
      expect(screen.queryByText('Foreground collection enabled.')).not.toBeInTheDocument();
      if (reasonCode === 'collector-owned') expect(screen.getByText(/held metadata ownership when this console started/)).toBeVisible();
      if (reasonCode === 'reconciliation-required') expect(screen.getByText(/The retained marker was not removed/)).toBeVisible();
    });

  it('marks a stale collector refusal as historical and does not repeat a current ownership claim', () => {
    render(<QuotaRefreshPanel historical refresh={undefined} collector={{ state: 'blocked', reasonCode: 'collector-owned', sampledAt: NOW }} onSelect={() => {}} />);
    expect(screen.getByText('Last reported: Collection blocked')).toHaveClass(badgeStyles.unknown);
    expect(screen.getByText(/Last reported detail: Another foreground collector/)).toBeVisible();
    expect(screen.getByText(/At that sample, replacement metadata reads were not scheduled/)).toBeVisible();
    expect(screen.queryByText('Collection blocked')).not.toBeInTheDocument();
  });

  it('keeps startup ownership distinct from current provider quota', () => {
    render(<QuotaRefreshPanel refresh={undefined} collector={{ state: 'running', reasonCode: 'collector-running', sampledAt: NOW }} onSelect={() => {}} />);
    expect(screen.getByText('Collector started')).toBeVisible();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText('Observed')).not.toBeInTheDocument();
  });

  it('never echoes arbitrary collector diagnostics', () => {
    const collector = { state: 'blocked', reasonCode: 'PRIVATE_SECRET /private/profile', sampledAt: NOW } as unknown as NonNullable<ResourceConsoleSnapshot['metadataCollector']>;
    const { container } = render(<QuotaRefreshPanel refresh={undefined} collector={collector} onSelect={() => {}} />);
    expect(screen.getByText('Collector details are unavailable.')).toBeVisible();
    expect(container.textContent).not.toContain('PRIVATE_SECRET'); expect(container.textContent).not.toContain('/private/profile');
  });

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

  it('explains unavailable saved allocation without implying admission', () => {
    render(<QuotaRefreshPanel refresh={snapshot([{ status: 'observed', reason: 'managed-allocation-unavailable' }])} onSelect={() => {}} />);
    expect(screen.getByText('Observed; allocation unavailable')).toHaveClass(badgeStyles.unknown);
    expect(screen.getByText('The saved usage allocation could not be read. Admission is withheld until allocation evidence is available.')).toBeVisible();
  });

  it('retains sample and schedule timestamps while making historical evidence non-current', () => {
    render(<QuotaRefreshPanel historical refresh={snapshot([{ status: 'observed', reason: 'managed-quota-observed',
      lastAttemptAt: NOW, lastSuccessAt: NOW, nextAttemptAt: NEXT }])} onSelect={() => {}} />);
    expect(screen.getByText('Last reported: Observed')).toHaveClass(badgeStyles.unknown);
    expect(screen.getByText(/Current collector activity and quota freshness are unverified/)).toBeVisible();
    expect(screen.getByText(/Last reported collector state: collection enabled/)).toBeVisible();
    expect(screen.getByRole('columnheader', { name: 'Previously scheduled attempt' })).toBeVisible();
    expect(screen.getByText(resourceTime(NOW))).toBeVisible();
    expect(screen.getByText(`Last attempt: ${resourceTime(NOW)}`)).toBeVisible();
    expect(screen.getByText(resourceTime(NEXT))).toBeVisible();
    expect(screen.getByText('Last reported detail: Native account hint and quota sample received.')).toBeVisible();
    expect(screen.queryByText('Observed')).not.toBeInTheDocument();
    expect(screen.queryByText(/Foreground collection enabled/)).not.toBeInTheDocument();
  });

  it.each([
    ['pending', 'Pending'], ['refreshing', 'Refreshing'], ['failed', 'Failed'], ['timed-out', 'Timed out'],
    ['cancelled', 'Cancelled'], ['expired', 'Expired'], ['uncertain', 'Uncertain'], ['closed', 'Closed'],
  ] as const)('neutralizes historical %s status without implying current collection', (status, label) => {
    const refresh = snapshot([{ status, reason: `managed-quota-${status}`, lastSuccessAt: NOW, nextAttemptAt: null }]);
    if (status === 'closed') refresh.state = 'closed';
    render(<QuotaRefreshPanel historical refresh={refresh} onSelect={() => {}} />);
    expect(screen.getByText(`Last reported: ${label}`)).toHaveClass(badgeStyles.unknown);
    expect(screen.queryByText(label)).not.toBeInTheDocument();
    expect(screen.getByText(status === 'refreshing' ? 'Previously in progress' : 'Previously not scheduled')).toBeVisible();
    if (status === 'closed') expect(screen.getByText(/Last reported collector state: stopped/)).toBeVisible();
    expect(screen.queryByText('Read in progress')).not.toBeInTheDocument();
  });

  it.each([
    ['managed-quota-unknown', 'Observed; quota unknown'],
    ['managed-quota-reserve-reached', 'Observed; reserve reached'],
    ['managed-allocation-unavailable', 'Observed; allocation unavailable'],
  ])('preserves historical constraint information for %s', (reason, label) => {
    render(<QuotaRefreshPanel historical refresh={snapshot([{ status: 'observed', reason }])} onSelect={() => {}} />);
    expect(screen.getByText(`Last reported: ${label}`)).toHaveClass(badgeStyles.unknown);
    expect(screen.queryByText(label)).not.toBeInTheDocument();
    expect(screen.getByText(/Last reported detail: .*Admission is withheld/)).toBeVisible();
  });

  it('uses a bounded unknown label for unrecognized status without echoing it', () => {
    const refresh = snapshot();
    Object.assign(refresh.workers[0]!, { status: 'PRIVATE_FUTURE_STATUS', reason: '__proto__', nextAttemptAt: null });
    const { container } = render(<QuotaRefreshPanel refresh={refresh} onSelect={() => {}} />);
    expect(screen.getByText('Unknown')).toBeVisible();
    expect(container.innerHTML).not.toContain('PRIVATE_FUTURE_STATUS');
  });
});
