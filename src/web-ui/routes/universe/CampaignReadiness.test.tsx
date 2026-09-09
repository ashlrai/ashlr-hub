import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UniverseCampaignReadinessView } from '../../../core/web/universe-console-types.js';
import { evictAll } from '../../data/cache.js';
import { CampaignReadiness } from './CampaignReadiness.js';

function report(overrides: Partial<UniverseCampaignReadinessView> = {}): UniverseCampaignReadinessView {
  return { schemaVersion: 1, readinessScope: 'recorded-campaign-evidence', campaignId: 'search',
    universeId: 'compiler', observedState: 'ready', sourceState: 'healthy', disposition: 'startable',
    reasonCode: 'never-started', resourceRuntimeRequired: true, sampledAt: '2026-09-08T12:00:00.000Z', ...overrides };
}
const response = (value = report()) => new Response(JSON.stringify(value));
beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('recorded campaign readiness disclosure', () => {
  it('reads only on demand, has no polling, and never dispatches', async () => {
    const user = userEvent.setup(); const fetch = vi.fn(async () => response()); vi.stubGlobal('fetch', fetch);
    const timer = vi.spyOn(window, 'setInterval');
    render(<CampaignReadiness campaignId="search" universeId="compiler" />);
    expect(fetch).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Check recorded readiness' }));
    await screen.findByText('Recorded evidence permitted a run attempt');
    expect(fetch).toHaveBeenCalledOnce();
    expect(timer.mock.calls.filter(([, delay]) => delay === 3_000 || delay === 15_000)).toHaveLength(0);
    expect(screen.getByText(/not current provider connection, quota, worker capacity/)).toBeInTheDocument();
    expect(screen.getByText('Explicit private runtime required for a run attempt')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^run|^start/i })).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ method: 'GET' }));
  });

  it.each([
    ['startable', 'Recorded evidence permitted a run attempt'], ['owned', 'Campaign owner was recorded active'],
    ['owner-held', 'Owner control held the campaign'], ['resource-withheld', 'Last attempt was withheld by resources'],
    ['recovery-required', 'Recovery inspection was required'], ['attention-required', 'Attention was required'],
    ['budget-exhausted', 'Recorded budget was exhausted'], ['terminal', 'Campaign had ended'], ['unavailable', 'Recorded check was unavailable'],
  ] as const)('renders %s as a past observation', async (disposition, label) => {
    vi.stubGlobal('fetch', vi.fn(async () => response(report({ disposition }))));
    render(<CampaignReadiness campaignId="search" universeId="compiler" />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Check recorded readiness' }));
    expect(await screen.findByText(label)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Last recorded check' })).toBeInTheDocument();
  });

  it('withholds advice while refreshing and keeps a failed refresh explicitly historical', async () => {
    const user = userEvent.setup(); const fetch = vi.fn(async () => response()); vi.stubGlobal('fetch', fetch);
    render(<CampaignReadiness campaignId="search" universeId="compiler" />);
    await user.click(screen.getByRole('button', { name: 'Check recorded readiness' }));
    await screen.findByText('Recorded evidence permitted a run attempt');
    let reject!: (reason: Error) => void;
    fetch.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    await user.click(screen.getByRole('button', { name: 'Refresh check' }));
    expect(screen.getByText('Previous sample only. A new check is pending.')).toBeInTheDocument();
    expect(screen.queryByText('Recorded evidence permitted a run attempt')).not.toBeInTheDocument();
    await act(async () => { reject(new Error('/private/customer token-secret')); });
    await screen.findByRole('alert');
    expect(screen.getByText('Previous sample only. The latest check failed.')).toBeInTheDocument();
    expect(screen.queryByText(/private\/customer|token-secret/)).not.toBeInTheDocument();
    expect(screen.queryByText('Recorded evidence permitted a run attempt')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Refresh check' }));
    await screen.findByText('Recorded evidence permitted a run attempt');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('reopens cached evidence as historical while obtaining a new sample', async () => {
    const user = userEvent.setup(); const fetch = vi.fn(async () => response()); vi.stubGlobal('fetch', fetch);
    render(<CampaignReadiness campaignId="search" universeId="compiler" />);
    await user.click(screen.getByRole('button', { name: 'Check recorded readiness' }));
    await screen.findByText('Recorded evidence permitted a run attempt');
    await user.click(screen.getByRole('button', { name: 'Hide recorded readiness' }));
    let finish!: (value: Response) => void;
    fetch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await user.click(screen.getByRole('button', { name: 'Check recorded readiness' }));
    expect(screen.getByText('Previous sample only. A new check is pending.')).toBeInTheDocument();
    expect(screen.queryByText('Recorded evidence permitted a run attempt')).not.toBeInTheDocument();
    await act(async () => { finish(response(report({ disposition: 'owner-held', reasonCode: 'owner-paused' }))); });
    await screen.findByText('Owner control held the campaign');
  });

  it('resets disclosure on a keyed campaign switch and rejects unrelated identities', async () => {
    const user = userEvent.setup(); const fetch = vi.fn(async () => response()); vi.stubGlobal('fetch', fetch);
    const { rerender } = render(<CampaignReadiness key="search" campaignId="search" universeId="compiler" />);
    await user.click(screen.getByRole('button', { name: 'Check recorded readiness' }));
    await screen.findByText('Recorded evidence permitted a run attempt');
    rerender(<CampaignReadiness key="other" campaignId="other" universeId="compiler" />);
    expect(screen.queryByText('Recorded evidence permitted a run attempt')).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'Check recorded readiness' }));
    await screen.findByRole('alert');
    expect(screen.queryByText('Recorded evidence permitted a run attempt')).not.toBeInTheDocument();
  });

  it('does not present missing or degraded evidence as startability', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(report({ sourceState: 'degraded', universeId: null, observedState: null, resourceRuntimeRequired: null, disposition: 'unavailable', reasonCode: 'snapshot-changed' }))));
    render(<CampaignReadiness campaignId="search" universeId="compiler" />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Check recorded readiness' }));
    await screen.findByText('Recorded evidence was unavailable or incomplete');
    expect(screen.getByText('snapshot-changed')).toBeInTheDocument();
    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });

  it('leaves shared in-flight reads usable after unmount', async () => {
    const user = userEvent.setup(); let finish!: (value: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })); vi.stubGlobal('fetch', fetch);
    const mounted = render(<CampaignReadiness campaignId="search" universeId="compiler" />);
    await user.click(screen.getByRole('button', { name: 'Check recorded readiness' }));
    mounted.unmount();
    render(<CampaignReadiness campaignId="search" universeId="compiler" />);
    await user.click(screen.getByRole('button', { name: 'Check recorded readiness' }));
    expect(fetch).toHaveBeenCalledOnce();
    await act(async () => { finish(response()); });
    await waitFor(() => expect(screen.getByText('Recorded evidence permitted a run attempt')).toBeInTheDocument());
  });
});
