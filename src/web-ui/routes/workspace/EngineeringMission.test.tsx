import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../data/auth-store.js';
import { controlResourceEngineeringMission, readResourceEngineeringMission } from '../../data/resource-pool-queries.js';
import type { EngineeringMissionSnapshot } from '../../../core/resources/engineering-mission-manager-types.js';
import { EngineeringMission } from './EngineeringMission.js';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function fixture() {
  let sample: EngineeringMissionSnapshot = { schemaVersion: 1, missionId: 'hub-improvement', controllerId: 'a'.repeat(32), configDigest: 'b'.repeat(64),
    revision: 0, enabled: false, autoStart: true, state: 'idle', phase: null, scope: 0, maxScopes: 3,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(), sampledAt: new Date().toISOString(), remainingMs: 60_000, lastOutcome: null };
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === 'POST') sample = { ...sample, revision: sample.revision + 1, enabled: url.endsWith('/start'), state: url.endsWith('/start') ? 'running' : 'stopping', phase: 'preparing' };
    return json(sample);
  }); vi.stubGlobal('fetch', fetcher);
  return { fetcher, sample: () => sample, patch: (patch: Partial<EngineeringMissionSnapshot>) => { sample = { ...sample, ...patch }; } };
}
beforeEach(() => setMutationToken('a'.repeat(64)));
afterEach(() => { act(() => clearMutationToken()); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
describe('standing mission operating strip', () => {
  it('withholds mission start while execution is stopped but preserves mission stop', async () => {
    const f = fixture(); const view = render(<EngineeringMission executionAvailable={false} unlocked onUnlock={vi.fn()} />);
    await screen.findByText('hub-improvement');
    expect(screen.getByRole('button', { name: 'Start mission' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Start mission' }));
    expect(f.fetcher.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
    f.patch({ enabled: true, state: 'running', phase: 'executing' });
    fireEvent.click(screen.getByRole('button', { name: 'Check mission status' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop mission' })).toBeEnabled());
    view.rerender(<EngineeringMission executionAvailable={false} unlocked onUnlock={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop mission' }));
    await waitFor(() => expect(f.fetcher.mock.calls.some(([url, options]) => url.endsWith('/stop') && options?.method === 'POST')).toBe(true));
  });
  it('observes without starting and uses exact identity/revision for explicit controls', async () => {
    const f = fixture(); render(<EngineeringMission executionAvailable unlocked onUnlock={vi.fn()} />);
    await screen.findByText('hub-improvement'); expect(f.fetcher.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
    expect(screen.getByRole('button', { name: 'Start mission' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Start mission' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop mission' })).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Start mission' })).toBeDisabled();
    expect(screen.getByText('Prepare')).toHaveAttribute('aria-current', 'step');
    fireEvent.click(screen.getByRole('button', { name: 'Stop mission' }));
    await screen.findByText('Stop saved. Waiting for mission-owned work to settle.');
    const posts = f.fetcher.mock.calls.filter(([, options]) => options?.method === 'POST');
    expect(posts.map(([url]) => url)).toEqual(['/api/resources/engineering-mission/start', '/api/resources/engineering-mission/stop']);
    expect(posts.map(([, options]) => JSON.parse(String(options?.body)))).toEqual([0, 1].map(expectedRevision => ({ expectedControllerId: 'a'.repeat(32), expectedConfigDigest: 'b'.repeat(64), expectedRevision })));
    expect(screen.getByRole('button', { name: 'Stop mission' })).toBeDisabled();
  });
  it('unlocks without generating and withholds expired or held starts', async () => {
    const f = fixture(), unlock = vi.fn(); render(<EngineeringMission executionAvailable unlocked={false} onUnlock={unlock} />);
    await screen.findByText('hub-improvement'); fireEvent.click(screen.getByRole('button', { name: 'Unlock to start mission' }));
    expect(unlock).toHaveBeenCalledOnce(); expect(f.fetcher.mock.calls.every(([, options]) => options?.method !== 'POST')).toBe(true);
    f.patch({ remainingMs: 0 }); fireEvent.click(screen.getByRole('button', { name: 'Check mission status' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Unlock to start mission' })).toBeDisabled());
    f.patch({ state: 'held', remainingMs: 1000 }); fireEvent.click(screen.getByRole('button', { name: 'Check mission status' }));
    await screen.findByRole('alert'); expect(screen.getByRole('button', { name: 'Unlock to start mission' })).toBeDisabled();
  });
  it('does not leave stale live controls enabled when status fails', async () => {
    const f = fixture(); render(<EngineeringMission executionAvailable unlocked onUnlock={vi.fn()} />); await screen.findByText('hub-improvement');
    f.fetcher.mockResolvedValue(json({}, 503)); fireEvent.click(screen.getByRole('button', { name: 'Check mission status' }));
    await screen.findByText('Live status unavailable. Controls wait for a fresh observation.');
    expect(screen.getByRole('button', { name: 'Start mission' })).toBeDisabled();
  });
  it('reconciles a lost mutation response without replaying the command', async () => {
    const f = fixture(); const normal = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, options) => { const result = await normal(url, options); if (options?.method === 'POST') throw Error('Lost reply'); return result; });
    render(<EngineeringMission executionAvailable unlocked onUnlock={vi.fn()} />); await screen.findByText('hub-improvement');
    fireEvent.click(screen.getByRole('button', { name: 'Start mission' })); await screen.findByRole('alert');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop mission' })).toBeEnabled());
    expect(f.fetcher.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
  });
  it('times out a stuck observer and can recover without accepting its late response', async () => {
    vi.useFakeTimers(); const f = fixture(); render(<EngineeringMission executionAvailable unlocked onUnlock={vi.fn()} />); await act(async () => {});
    let finish!: (value: Response) => void;
    f.fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: 'Check mission status' }));
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(screen.getByRole('button', { name: 'Start mission' })).toBeDisabled();
    f.patch({ state: 'completed' }); fireEvent.click(screen.getByRole('button', { name: 'Check mission status' })); await act(async () => {});
    await act(async () => finish(json({ ...f.sample(), state: 'running' })));
    expect(screen.getByText('completed')).toBeInTheDocument(); expect(screen.queryByText('running')).not.toBeInTheDocument();
  });
  it.each([{ state: 'invented' }, { phase: 'private prompt' }, { revision: -1 }, { remainingMs: NaN }, { controllerId: 'wrong' }, { maxScopes: 100 }])('refuses malformed status %j', async patch => {
    const f = fixture(); f.fetcher.mockResolvedValue(json({ ...f.sample(), ...patch })); await expect(readResourceEngineeringMission()).rejects.toThrow('verified');
  });
  it('rejects a mismatched control acknowledgement', async () => {
    const f = fixture(); f.fetcher.mockResolvedValue(json({ ...f.sample(), enabled: true, revision: 1, controllerId: 'c'.repeat(32) }));
    await expect(controlResourceEngineeringMission('start', { expectedControllerId: 'a'.repeat(32), expectedConfigDigest: 'b'.repeat(64), expectedRevision: 0 })).rejects.toThrow('not confirmed');
  });
});
