/**
 * CloudCreditsPanel (Usage) and CloudLaneChip (Fleet) — the two small cloud
 * mounts outside Command: the panel shows the same estimate and edits the
 * same budget fields; the chip reads "Cloud · N running" in the lanes row.
 * Both vanish on a server without the cloud lane.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { LanesStrip } from '../fleet/FleetCards.js';
import { fleetLive } from '../command/fixtures.test-support.js';
import { resetActivityForTest } from '../shell/useActivity.js';
import { CloudCreditsPanel } from './CloudCreditsPanel.js';
import { CloudLaneChip } from './CloudLaneChip.js';
import { budgetView, overview, stubCloudFetch, task } from './cloud-fixtures.test-support.js';

const TOKEN = 'f'.repeat(64);

beforeEach(() => {
  evictAll();
  resetActivityForTest(async () => { throw new Error('no activity in this test'); });
  clearMutationToken();
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearMutationToken();
  resetActivityForTest();
});

describe('CloudCreditsPanel', () => {
  it('shows the estimate, its note and link, and the budget fields', async () => {
    stubCloudFetch(overview({ budget: budgetView({ estimatedSpentUsd: 50 }) }));
    render(<CloudCreditsPanel />);
    const panel = await screen.findByRole('region', { name: 'Cloud credits' });
    expect(within(panel).getByText('$200 of $250 · estimate')).toBeInTheDocument();
    expect(within(panel).getByRole('meter', { name: /Estimated cloud credits remaining: \$200 of \$250 · estimate, 20% used/ })).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: 'Check the real balance on claude.ai' })).toHaveAttribute('href', 'https://claude.ai/settings/usage');
    for (const label of ['Credits on the account', 'Already spent', 'Estimate per session', 'Sessions per day', 'Running at once', 'Self-improvement per day', 'Reserve']) {
      expect(within(panel).getByLabelText(label)).toBeInTheDocument();
    }
    expect(within(panel).getByLabelText('Credits on the account')).toHaveValue('250');
    expect(within(panel).getByRole('switch', { name: 'Verse may launch self-improvement tasks on its own' })).toHaveAttribute('aria-checked', 'true');
  });

  it('saves a calibration after checking claude.ai — only the changed field', async () => {
    setMutationToken(TOKEN);
    const { posted } = stubCloudFetch(overview());
    const user = userEvent.setup();
    render(<CloudCreditsPanel />);
    const panel = await screen.findByRole('region', { name: 'Cloud credits' });
    const spent = within(panel).getByLabelText('Already spent');
    await user.clear(spent);
    await user.type(spent, '17.25');
    await user.click(within(panel).getByRole('switch', { name: 'Verse may launch self-improvement tasks on its own' }));
    await user.click(within(panel).getByRole('button', { name: 'Save budget' }));
    await waitFor(() => expect(posted).toEqual([
      { url: '/api/verse/cloud/budget', body: { creditsSpentAdjustmentUsd: 17.25, selfImprove: { enabled: false } } },
    ]));
  });

  it('says "Nothing changed." instead of sending an empty update', async () => {
    setMutationToken(TOKEN);
    const { posted } = stubCloudFetch(overview());
    const user = userEvent.setup();
    render(<CloudCreditsPanel />);
    const panel = await screen.findByRole('region', { name: 'Cloud credits' });
    await user.click(within(panel).getByRole('button', { name: 'Save budget' }));
    expect(within(panel).getByRole('status')).toHaveTextContent('Nothing changed.');
    expect(posted).toEqual([]);
  });

  it('renders nothing on a server without the cloud lane', async () => {
    const { fetchMock } = stubCloudFetch(null);
    const { container } = render(<CloudCreditsPanel />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });
});

describe('CloudLaneChip', () => {
  it('counts queued, launching and running tasks — not PRs or finished ones', async () => {
    stubCloudFetch(overview({ tasks: [task('running'), task('queued'), task('launching'), task('pr-open'), task('failed')] }));
    render(<ul><CloudLaneChip /></ul>);
    const chip = await screen.findByRole('listitem', { name: 'Cloud: 3 running' });
    expect(chip).toHaveTextContent('Cloud · 3 running');
    expect(chip).toHaveAttribute('data-active', 'true');
    expect(chip.getAttribute('title')).toMatch(/^Claude Code cloud sessions Verse launched/);
  });

  it('reads "0 running" when idle, and is absent without the cloud lane', async () => {
    stubCloudFetch(overview());
    const { unmount } = render(<ul><CloudLaneChip /></ul>);
    expect(await screen.findByText('0 running')).toBeInTheDocument();
    unmount();
    evictAll();
    const { fetchMock } = stubCloudFetch(null);
    const { container } = render(<ul><CloudLaneChip /></ul>);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector('li')).toBeNull();
  });

  it('sits at the end of Fleet’s lanes row', async () => {
    stubCloudFetch(overview({ tasks: [task('running')] }));
    render(<LanesStrip live={fleetLive('live', Date.now())} />);
    const lanes = screen.getByRole('list', { name: 'Lanes: busy of slots' });
    await within(lanes).findByRole('listitem', { name: 'Cloud: 1 running' });
    const items = within(lanes).getAllByRole('listitem');
    expect(items[items.length - 1]).toHaveTextContent('Cloud · 1 running');
  });
});
