import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ResourceCollectorInspection } from '../../../core/resources/console-types.js';
import { CollectorInspectionPanel } from './CollectorInspectionPanel.js';
import badgeStyles from '../../components/primitives/StatusBadge.module.css';

const NOW = '2026-09-12T12:00:00.000Z';
const legacy: ResourceCollectorInspection = { scope: 'local-record-inspection', sampledAt: NOW,
  state: 'pending', markerVersion: 1, reasonCode: 'legacy-owner-evidence-missing', recoveryAttempted: false };
describe('passive collector inspection presentation', () => {
  it('explains missing legacy proof without suggesting deletion, reboot recovery or startup', () => {
    const { container } = render(<CollectorInspectionPanel inspection={legacy} />);
    expect(screen.getByText('Legacy ownership evidence missing')).toHaveClass(badgeStyles.warning);
    expect(screen.getByText(/original owner, boot and process-group proof/)).toBeVisible();
    expect(screen.getByText(/do not delete it/)).toBeVisible();
    expect(screen.getByText(/reboot alone does not establish cleanup/)).toBeVisible();
    expect(screen.getByText(/No collector startup or recovery was attempted/)).toBeVisible();
    expect(container.querySelector('time')).toHaveAttribute('dateTime', NOW);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByText('Collection blocked')).not.toBeInTheDocument();
    expect(screen.getByText(/does not change account pauses, quota reservations or usage ceilings/)).toBeVisible();
  });
  it.each([2, 3, 4] as const)('describes version %s as unevaluated, not unrecoverable', markerVersion => {
    render(<CollectorInspectionPanel inspection={{ ...legacy, markerVersion, reasonCode: 'recovery-not-evaluated' }} />);
    expect(screen.getByText('Pending record observed')).toBeVisible();
    expect(screen.getByText(/does not mean the record is unrecoverable/)).toBeVisible();
    expect(screen.queryByText(/do not delete it/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
  it('does not equate an absent record with readiness', () => {
    render(<CollectorInspectionPanel inspection={{ ...legacy, state: 'absent', markerVersion: null, reasonCode: 'no-pending-record' }} />);
    expect(screen.getByText('No pending record observed')).toHaveClass(badgeStyles.neutral);
    expect(screen.getByText(/does not establish collector readiness or fresh quota evidence/)).toBeVisible();
  });
  it('keeps unavailable evidence unknown', () => {
    render(<CollectorInspectionPanel inspection={{ ...legacy, state: 'unavailable', markerVersion: null, reasonCode: 'pending-evidence-unavailable' }} />);
    expect(screen.getByText('Record inspection unavailable')).toHaveClass(badgeStyles.unknown);
    expect(screen.getByText(/presence and contents are not established/)).toBeVisible();
  });
  it.each(['pending', 'absent', 'unavailable'] as const)('labels retained %s reports historical', state => {
    const inspection: ResourceCollectorInspection = state === 'pending' ? legacy : { ...legacy, state, markerVersion: null,
      reasonCode: state === 'absent' ? 'no-pending-record' : 'pending-evidence-unavailable' };
    const { container } = render(<CollectorInspectionPanel inspection={inspection} historical />);
    expect(screen.getByText(/^Last reported:/)).toHaveClass(badgeStyles.unknown);
    expect(screen.getByText(/Current collector records, activity and quota freshness are unverified/)).toBeVisible();
    expect(screen.getByText(/^At that sample:/)).toBeVisible();
    expect(container.querySelector('time')).toHaveAttribute('dateTime', NOW);
  });
  it.each([{ reasonCode: 'PRIVATE_REASON /secret' }, { sampledAt: 'PRIVATE_DATE' },
    { markerVersion: 4 }, { recoveryAttempted: true }, { privateToken: 'PRIVATE_TOKEN' }])('rejects unsafe direct props without echoing them %#', override => {
    const { container } = render(<CollectorInspectionPanel inspection={{ ...legacy, ...override } as never} />);
    expect(screen.getByText('Record inspection unavailable')).toBeVisible();
    expect(container.textContent).not.toContain('PRIVATE'); expect(container.querySelector('time')).toBeNull();
    expect(screen.queryByText(/original owner, boot and process-group proof/)).not.toBeInTheDocument();
  });
  it('omits the panel for older servers', () => {
    const { container } = render(<CollectorInspectionPanel />); expect(container).toBeEmptyDOMElement();
  });
});
