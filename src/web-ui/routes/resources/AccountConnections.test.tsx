import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ResourceAccountConnection, ResourceConnectionsSnapshot } from '../../../core/resources/connection-types.js';
import { AccountConnections } from './AccountConnections.js';
import { resourceTime } from './CapacityBoard.js';

const NOW = '2026-09-08T12:00:00.000Z';
const LATER = '2026-09-08T12:05:00.000Z';
const RESET = '2026-09-08T15:00:00.000Z';
function account(patch: Partial<ResourceAccountConnection> = {}): ResourceAccountConnection {
  return { id: 'codex-a', label: 'Personal', provider: 'codex', state: 'observed', authentication: 'signed-in',
    health: 'reachable', planType: 'pro', observedAt: NOW, expiresAt: LATER,
    windows: [{ id: 'five-hour', usedPercent: 25, resetsAt: RESET }], reason: 'observed',
    onDemandEnabled: null, executionSupported: true, ...patch };
}
function snapshot(accounts = [account()], patch: Partial<ResourceConnectionsSnapshot> = {}): ResourceConnectionsSnapshot {
  return { sampledAt: NOW, refreshing: false, accounts, ...patch };
}

describe('account connections evidence', () => {
  it('shows approximate Claude native usage without claiming cache freshness or ceiling headroom', () => {
    render(<AccountConnections ceilingPercent={75} connections={snapshot([account({ provider: 'claude',
      label: 'Claude', health: 'unknown', reason: 'usage-native-reported', windows: [{ id: 'seven_day_fable', usedPercent: 2,
        resetsAt: null, nativeReport: { source: 'claude-usage', resetDescription: 'Sep 11 at 7pm (America/New_York)' } }] })])} />);
    expect(screen.getByText('≈ 2% used')).toBeVisible();
    expect(screen.getByText('7-day window · Fable')).toBeVisible();
    expect(screen.getByText(/may be cached/)).toBeVisible();
    expect(screen.getByText('Resets: Sep 11 at 7pm (America/New_York)')).toBeVisible();
    expect(screen.getByRole('meter')).toHaveAttribute('data-historical', 'true');
    expect(screen.queryByText(/73 percentage points below/)).not.toBeInTheDocument();
    expect(screen.queryByText('Metadata reachable')).not.toBeInTheDocument();
  });
  it.each(['usage-version-unsupported', 'usage-account-changed', 'usage-output-invalid', 'usage-process-failed', 'usage-identity-unavailable'])(
    'provides native Claude recovery guidance for %s', (reason) => {
      render(<AccountConnections connections={snapshot([account({ provider: 'claude', windows: [], reason })])} />);
      expect(screen.getByText('Quota unknown')).toBeVisible();
      expect(screen.getAllByText(/native|profile/i).length).toBeGreaterThan(0);
    });
  it.each([undefined, null])('omits unconfigured connection checks %#', (connections) => {
    const { container } = render(<AccountConnections connections={connections} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('reports an empty roster without inventing connected accounts', () => {
    render(<AccountConnections connections={snapshot([])} />);
    expect(screen.getByText('No accounts configured for connection checks.')).toBeVisible();
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
    expect(screen.queryByText('Signed in')).not.toBeInTheDocument();
  });

  it('keeps both operator-labeled Codex accounts and each quota window separate', () => {
    render(<AccountConnections connections={snapshot([
      account(), account({ id: 'codex-b', label: 'Cash Margin Partners', planType: 'business',
        windows: [{ id: 'five-hour', usedPercent: 40, resetsAt: RESET }, { id: 'weekly', usedPercent: 60, resetsAt: LATER }] }),
    ])} />);
    const personal = screen.getByRole('listitem', { name: 'Personal connection' });
    const business = screen.getByRole('listitem', { name: 'Cash Margin Partners connection' });
    expect(within(personal).getByRole('heading', { name: 'Personal' })).toBeVisible();
    expect(within(personal).getByText('25% used')).toBeVisible();
    expect(within(business).getByText('40% used')).toBeVisible();
    expect(within(business).getByText('60% used')).toBeVisible();
    expect(within(business).getByText(`Resets: ${resourceTime(RESET)}`)).toBeVisible();
    expect(screen.getAllByText('Signed in')).toHaveLength(2);
    expect(screen.getAllByText('Metadata reachable')).toHaveLength(2);
    expect(screen.getAllByRole('meter')).toHaveLength(3);
    expect(screen.getByText(/Accounts may share allowances; percentages are not added together/)).toBeVisible();
    expect(screen.queryByText('65% used')).not.toBeInTheDocument();
  });

  it('distinguishes an explicit zero from unknown and missing windows', () => {
    render(<AccountConnections connections={snapshot([
      account({ windows: [{ id: 'known', usedPercent: 0, resetsAt: RESET }, { id: 'unknown', usedPercent: null, resetsAt: null }] }),
      account({ id: 'claude', label: 'Claude Max', provider: 'claude', windows: [], planType: null }),
    ])} />);
    expect(screen.getByText('0% used')).toBeVisible();
    expect(screen.getByText('Unknown')).toBeVisible();
    expect(screen.getByText('Resets: Not reported')).toBeVisible();
    expect(screen.getByText('Quota unknown')).toBeVisible();
    expect(screen.getByText('No quota windows reported. Available capacity is not established.')).toBeVisible();
    expect(screen.getAllByRole('meter')).toHaveLength(1);
    expect(screen.getByRole('meter')).toHaveAttribute('value', '0');
    expect(screen.queryByText(/^Ready$/i)).not.toBeInTheDocument();
  });

  it.each([
    { name: 'expired', patch: { expiresAt: NOW }, historical: false },
    { name: 'missing timestamp', patch: { observedAt: null }, historical: false },
    { name: 'future timestamp', patch: { observedAt: LATER }, historical: false },
    { name: 'invalid timestamp', patch: { expiresAt: 'invalid' }, historical: false },
    { name: 'in-progress check', patch: { state: 'checking' as const }, historical: false },
    { name: 'failed check', patch: { state: 'unavailable' as const }, historical: false },
    { name: 'failed console read', patch: {}, historical: true },
  ])('neutralizes current sign-in, health and meters on $name', ({ patch, historical }) => {
    render(<AccountConnections connections={snapshot([account(patch)])} historical={historical} />);
    expect(screen.queryByText('Signed in')).not.toBeInTheDocument();
    expect(screen.queryByText('Metadata reachable')).not.toBeInTheDocument();
    expect(screen.getByText('Sign-in unverified')).toBeVisible();
    expect(screen.getByText('Last reported usage')).toBeVisible();
    expect(screen.getByRole('meter')).toHaveAttribute('data-historical', 'true');
    expect(screen.getByRole('listitem')).toHaveAttribute('data-current', 'false');
    expect(screen.getByText('25% used')).toBeVisible();
  });

  it('treats an invalid sample timestamp as unverified', () => {
    render(<AccountConnections connections={snapshot([account()], { sampledAt: 'invalid' })} />);
    expect(screen.getByText('Evidence expired or missing')).toBeVisible();
    expect(screen.queryByText('Signed in')).not.toBeInTheDocument();
  });

  it('shows signed-out health separately and directs native sign-in without browser actions', () => {
    render(<AccountConnections connections={snapshot([account({ state: 'signed-out', authentication: 'signed-out', windows: [] })])} />);
    expect(screen.getByText('Sign-in required')).toBeVisible();
    expect(screen.getByText('Metadata reachable')).toBeVisible();
    expect(screen.getByText(/Sign in through this account’s native launcher/)).toBeVisible();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('always distinguishes Grok metadata from unintegrated execution', () => {
    render(<AccountConnections connections={snapshot([account({ provider: 'grok', label: 'SuperGrok', planType: 'supergrok',
      executionSupported: true, onDemandEnabled: true })])} />);
    expect(screen.getByText('Execution not integrated')).toBeVisible();
    expect(screen.getByText('Grok metadata does not enable Hub execution.')).toBeVisible();
    expect(screen.getByText('On-demand billing enabled')).toBeVisible();
    expect(screen.queryByText('Hub transport available')).not.toBeInTheDocument();
  });

  it('does not present historical billing metadata as current configuration', () => {
    render(<AccountConnections connections={snapshot([account({ onDemandEnabled: false })])} historical />);
    expect(screen.getByText('Last reported: On-demand billing disabled')).toBeVisible();
    expect(screen.getByText('Historical snapshot')).toBeVisible();
  });

  it('reports exhausted usage without confusing it with signed-out status', () => {
    render(<AccountConnections connections={snapshot([account({ windows: [{ id: 'weekly', usedPercent: 100, resetsAt: RESET }] })])} />);
    expect(screen.getByText('100% used')).toBeVisible();
    expect(screen.getByText('Signed in')).toBeVisible();
    expect(screen.queryByText('Sign-in required')).not.toBeInTheDocument();
  });

  it('does not reinterpret a passed reset as fresh available capacity', () => {
    render(<AccountConnections connections={snapshot([account({ windows: [{ id: 'weekly', usedPercent: 100, resetsAt: NOW }] })])} />);
    expect(screen.getByText('100% used')).toBeVisible();
    expect(screen.getByText('Reset passed; a new quota sample is needed.')).toBeVisible();
    expect(screen.getByRole('meter')).toHaveAttribute('data-historical', 'true');
    expect(screen.queryByText('0% used')).not.toBeInTheDocument();
  });

  it.each([NaN, Infinity, -1, 101])('never renders malformed usage %s as capacity', (usedPercent) => {
    render(<AccountConnections connections={snapshot([account({ windows: [{ id: 'weekly', usedPercent, resetsAt: null }] })])} />);
    expect(screen.getByText('Unknown')).toBeVisible();
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
  });

  it('never echoes raw diagnostics, unexpected plan identifiers or private metadata', () => {
    const row = account({ state: 'unavailable', reason: 'PRIVATE_ERROR /private/auth fixture@example.invalid', planType: 'PRIVATE_PLAN' });
    Object.assign(row, { email: 'fixture@example.invalid', accountHint: 'a'.repeat(64), command: '/private/launcher' });
    const { container } = render(<AccountConnections connections={snapshot([row])} />);
    expect(screen.getByText('Check unavailable')).toBeVisible();
    expect(screen.getByText(/Plan not reported/)).toBeVisible();
    for (const value of ['PRIVATE_ERROR', '/private/', 'fixture@example.invalid', 'a'.repeat(64), 'PRIVATE_PLAN']) {
      expect(container.innerHTML).not.toContain(value);
    }
  });

  it('reuses the snapshot refresh state without introducing controls or timers', () => {
    const { rerender } = render(<AccountConnections connections={snapshot([], { refreshing: true })} />);
    expect(screen.getByText('Checking account metadata…')).toBeVisible();
    rerender(<AccountConnections connections={snapshot()} />);
    expect(screen.getByText(`Sampled ${resourceTime(NOW)}`)).toBeVisible();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it.each([
    ['codex', 'codex_codex_primary', 'Primary window'], ['codex', 'codex_codex_secondary', 'Secondary window'],
    ['codex', 'codex_review_primary', 'review Primary window'], ['codex', 'five_hour', '5-hour window'],
    ['claude', 'seven_day', '7-day window'], ['grok', 'grok_unified_weekly', 'Weekly shared quota'],
    ['grok', 'grok_build_monthly', 'Monthly build quota'], ['grok', 'grok_credits', 'Credits quota'],
    ['codex', 'future_window', 'future_window'],
  ] as const)('names %s %s without fabricating a duration', (provider, id, label) => {
    render(<AccountConnections connections={snapshot([account({ provider, windows: [{ id, usedPercent: 25, resetsAt: RESET }] })])} />);
    expect(screen.getByText(label)).toBeVisible();
    expect(screen.getByRole('meter', { name: `Personal ${label} reported usage` })).toHaveAttribute('value', '25');
    if (id.endsWith('primary') || id.endsWith('secondary')) {
      expect(screen.queryByText(/5-hour|7-day|Weekly/)).not.toBeInTheDocument();
    }
  });

  it('compares individual fresh windows to the saved reference, not summed or free capacity', () => {
    render(<AccountConnections ceilingPercent={75} connections={snapshot([
      account({ windows: [{ id: 'five_hour', usedPercent: 97, resetsAt: RESET }, { id: 'seven_day', usedPercent: 74, resetsAt: RESET }] }),
      account({ id: 'codex-b', label: 'Company', windows: [{ id: 'five_hour', usedPercent: 0, resetsAt: RESET }] }),
    ])} />);
    expect(screen.getByText('75% saved pool reference')).toBeVisible();
    expect(screen.getByText('25% personal headroom target')).toBeVisible();
    expect(screen.getByText('22 percentage points above the 75% reference')).toBeVisible();
    expect(screen.getByText('1 percentage point below the 75% reference')).toBeVisible();
    expect(screen.getByText('75 percentage points below the 75% reference')).toBeVisible();
    expect(screen.getByText('Comparison only, not account dispatch eligibility.')).toBeVisible();
    expect(screen.queryByText(/available tokens|ready to dispatch|75% remaining/i)).not.toBeInTheDocument();
  });

  it.each([0, 100])('shows a valid reference at the %s%% endpoint without implying new authority', (ceiling) => {
    render(<AccountConnections ceilingPercent={ceiling} connections={snapshot([account({
      windows: [{ id: 'five_hour', usedPercent: ceiling, resetsAt: RESET }],
    })])} />);
    expect(screen.getByText(`At the ${ceiling}% reference ceiling`)).toBeVisible();
    expect(screen.getByText(`${100 - ceiling}% personal headroom target`)).toBeVisible();
  });

  it.each([undefined, null, -1, 101, 75.5, NaN])('omits comparisons without a valid saved ceiling %#', (ceiling) => {
    render(<AccountConnections ceilingPercent={ceiling} connections={snapshot()} />);
    expect(screen.queryByText(/saved pool reference|percentage points|personal headroom target/)).not.toBeInTheDocument();
    expect(screen.getByText('25% used')).toBeVisible();
  });

  it.each([
    { account: { expiresAt: NOW } }, { account: { state: 'unavailable' as const } },
    { account: { windows: [{ id: 'five_hour', usedPercent: null, resetsAt: RESET }] } },
    { account: { windows: [{ id: 'five_hour', usedPercent: 25, resetsAt: null }] } },
    { account: { windows: [{ id: 'five_hour', usedPercent: 25, resetsAt: NOW }] } },
  ])('withholds numeric headroom when window freshness or usage is unknown %#', (input) => {
    render(<AccountConnections ceilingPercent={75} connections={snapshot([account(input.account)])} />);
    expect(screen.getByText('Reference comparison unavailable until quota and freshness are known.')).toBeVisible();
    expect(screen.queryByText(/percentage points/)).not.toBeInTheDocument();
  });

  it('removes current comparisons on historical console reads', () => {
    render(<AccountConnections ceilingPercent={75} connections={snapshot()} historical />);
    expect(screen.queryByText(/saved pool reference|percentage points|personal headroom target/)).not.toBeInTheDocument();
    expect(screen.getByText('Historical snapshot')).toBeVisible();
    expect(screen.getByRole('meter')).toHaveAttribute('data-historical', 'true');
  });

  it('keeps Grok comparisons explicitly unrelated to Hub execution', () => {
    render(<AccountConnections ceilingPercent={75} connections={snapshot([account({ provider: 'grok', executionSupported: false,
      windows: [{ id: 'grok_build_weekly', usedPercent: 8, resetsAt: RESET }],
    })])} />);
    expect(screen.getByText('67 percentage points below the 75% reference')).toBeVisible();
    expect(screen.getByText('Grok metadata does not enable Hub execution.')).toBeVisible();
    expect(screen.getByText('Execution not integrated')).toBeVisible();
  });

  it('explains why fresh native Claude sign-in provides no quota and offers a native next step', () => {
    render(<AccountConnections ceilingPercent={75} connections={snapshot([account({ provider: 'claude',
      reason: 'status-login-observed', health: 'unknown', windows: [],
    })])} />);
    expect(screen.getByText('Signed in')).toBeVisible();
    expect(screen.getByText('Quota unknown')).toBeVisible();
    expect(screen.getByText(/Native auth status confirms sign-in but does not report allowance/)).toBeVisible();
    expect(screen.getByText(/Check usage in this account’s native Claude session/)).toBeVisible();
    expect(screen.queryByText(/percentage points/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('offers a fixed stopped-monitor recovery step without echoing diagnostics', () => {
    render(<AccountConnections connections={snapshot([account({ state: 'unavailable', reason: 'connection-monitor-stopped', windows: [] })])} />);
    expect(screen.getByText(/Restart the scoped console to collect a new sample/)).toBeVisible();
    expect(screen.queryByText('Signed in')).not.toBeInTheDocument();
  });
});

describe('account-level reference summary', () => {
  function summary() {
    return within(screen.getByRole('region', { name: 'Personal account reference summary' }));
  }

  it('uses the most-used window rather than adding percentages', () => {
    render(<AccountConnections ceilingPercent={75} connections={snapshot([account({ windows: [
      { id: 'five_hour', usedPercent: 20, resetsAt: RESET },
      { id: 'seven_day', usedPercent: 60, resetsAt: RESET },
    ] })])} />);
    expect(summary().getByText('15 percentage points below the 75% reference across reported windows.')).toBeVisible();
    expect(summary().getByText('Most-used window: 7-day window.')).toBeVisible();
    expect(summary().getByText('Reference comparison only; not dispatch eligibility or a token allowance.')).toBeVisible();
    expect(summary().queryByText(/80%|available tokens|ready to dispatch/i)).not.toBeInTheDocument();
  });

  it('names every tied most-used window without inventing durations', () => {
    render(<AccountConnections ceilingPercent={75} connections={snapshot([account({ windows: [
      { id: 'codex_codex_primary', usedPercent: 74, resetsAt: RESET },
      { id: 'codex_codex_secondary', usedPercent: 74, resetsAt: RESET },
    ] })])} />);
    expect(summary().getByText('1 percentage point below the 75% reference across reported windows.')).toBeVisible();
    expect(summary().getByText('Most-used windows: Primary window · Secondary window.')).toBeVisible();
    expect(summary().queryByText(/5-hour|7-day/)).not.toBeInTheDocument();
  });

  it.each([75, 90])('reports no margin at or above the reference (%s%% used)', (usedPercent) => {
    render(<AccountConnections ceilingPercent={75} connections={snapshot([account({ windows: [
      { id: 'weekly', usedPercent, resetsAt: RESET },
    ] })])} />);
    expect(summary().getByText('No margin below the 75% reference.')).toBeVisible();
    expect(summary().queryByText(/percentage points|available|remaining/)).not.toBeInTheDocument();
  });

  it('distinguishes subprecision margin from reaching the reference', () => {
    render(<AccountConnections ceilingPercent={75} connections={snapshot([account({ windows: [
      { id: 'weekly', usedPercent: 74.999, resetsAt: RESET },
    ] })])} />);
    expect(summary().getByText('Less than 0.01 percentage point below the 75% reference across reported windows.')).toBeVisible();
    expect(summary().queryByText(/No margin|^0 percentage points/)).not.toBeInTheDocument();
  });

  it.each([
    { name: 'unknown usage alongside a known window', patch: { windows: [
      { id: 'five_hour', usedPercent: 20, resetsAt: RESET }, { id: 'seven_day', usedPercent: null, resetsAt: RESET },
    ] } },
    { name: 'expired evidence', patch: { expiresAt: NOW } },
    { name: 'historical snapshot', patch: {}, historical: true },
    { name: 'passed reset alongside a current window', patch: { windows: [
      { id: 'five_hour', usedPercent: 20, resetsAt: RESET }, { id: 'seven_day', usedPercent: 10, resetsAt: NOW },
    ] } },
    { name: 'native cached Claude usage', patch: { provider: 'claude' as const, windows: [
      { id: 'seven_day', usedPercent: 2, resetsAt: RESET,
        nativeReport: { source: 'claude-usage' as const, resetDescription: 'Tomorrow' } },
    ] } },
  ])('withholds the numeric account summary for $name', ({ patch, historical = false }) => {
    render(<AccountConnections ceilingPercent={75} connections={snapshot([account(patch)])} historical={historical} />);
    expect(summary().getByText('Account reference summary unavailable: verified usage, freshness and a saved reference are required for every window.')).toBeVisible();
    expect(summary().queryByText(/percentage points|Most-used|No margin|[0-9]+%/)).not.toBeInTheDocument();
  });
});
