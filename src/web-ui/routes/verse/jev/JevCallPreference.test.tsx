import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JevResponse } from '../../../../core/decide/jev-types.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { JevCallPreference } from './JevCallPreference.js';
import { narrowJevResponse } from './jev-model.js';

function response(value: number | null = 1500): JevResponse {
  return narrowJevResponse({ generatedAt: '2026-10-01T12:00:00.000Z', config: { dailyCallBudget: value }, kinds: [], status: {
    enabled: true, keyed: true, day: '2026-10-01', decisionsToday: 0, callsToday: 0, dailyCallBudget: value, estCostUsdToday: 0,
    fallbackRateToday: 0, avgConfidenceToday: null, avgLatencyMsToday: null, byKind: [],
  } })!;
}
let posts: unknown[];
let post: (value: number | null) => Promise<Response>;
let writable: boolean;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
beforeEach(() => {
  evictAll(); clearMutationToken(); setMutationToken('a'.repeat(64)); posts = []; writable = true;
  post = async (value) => json(response(value));
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { dailyCallBudget: number | null }; posts.push(body);
      expect(String(input)).toBe('/api/verse/jev/config');
      return post(body.dailyCallBudget);
    }
    if (String(input) === '/api/verse/bootstrap') return json({ seats: [], projects: [], sessions: [], dispatchEnabled: writable, localRuntime: {} });
    return json({ error: 'not found' }, 404);
  }));
});
afterEach(() => { clearMutationToken(); evictAll(); vi.unstubAllGlobals(); });

async function open() {
  const user = userEvent.setup(); render(<JevCallPreference response={response()} />);
  await user.click(screen.getByText('Daily call preference'));
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Requests per day' })).toBeEnabled());
  return user;
}
describe('explicit Jev call-count preference', () => {
  it('saves explicit null through the existing mutation gate and confirms exact readback', async () => {
    const user = await open();
    await user.click(screen.getByRole('checkbox', { name: 'No preference limit' }));
    await user.click(screen.getByRole('button', { name: 'Save preference' }));
    await screen.findByText('Preference saved. Enabled state and Stop are unchanged.');
    expect(posts).toEqual([{ dailyCallBudget: null }]);
    expect(screen.getByRole('checkbox')).toBeChecked();
  });
  it.each(['0', '1501', '9007199254740991'])('roundtrips valid %s without a hidden preference ceiling', async (text) => {
    const user = await open(); fireEvent.change(screen.getByRole('textbox'), { target: { value: text } });
    await user.click(screen.getByRole('button', { name: 'Save preference' }));
    await screen.findByText('Preference saved. Enabled state and Stop are unchanged.');
    expect(posts).toEqual([{ dailyCallBudget: Number(text) }]);
  });
  it.each(['17.5', '-1', '17junk', '', '9007199254740992'])('rejects invalid %s before mutation', async (text) => {
    const user = await open(); fireEvent.change(screen.getByRole('textbox'), { target: { value: text } });
    await user.click(screen.getByRole('button', { name: 'Save preference' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/nonnegative whole number/); expect(posts).toEqual([]);
  });
  it('holds pending saves and retains the choice on refused or mismatched readback', async () => {
    let finish!: (value: Response) => void;
    post = () => new Promise((resolve) => { finish = resolve; });
    const user = await open(); fireEvent.change(screen.getByRole('textbox'), { target: { value: '2000' } });
    await user.click(screen.getByRole('button', { name: 'Save preference' }));
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    await act(async () => { finish(json(response(1500))); });
    expect(await screen.findByRole('alert')).toHaveTextContent('Your choice is kept');
    expect(screen.getByRole('textbox')).toHaveValue('2000');
    expect(screen.queryByText(/Preference saved/)).toBeNull(); expect(posts).toHaveLength(1);
  });
  it('does not admit late success after the mutation session is cleared', async () => {
    let finish!: (value: Response) => void;
    post = () => new Promise((resolve) => { finish = resolve; });
    const user = await open(); await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Save preference' }));
    await act(async () => { clearMutationToken(); finish(json(response(null))); });
    expect(await screen.findByRole('alert')).toHaveTextContent('Your choice is kept');
    expect(screen.queryByText(/Preference saved/)).toBeNull();
  });
  it('does not silently turn unsupported old servers into an uncapped preference', () => {
    const old = response(); delete (old as { config?: unknown }).config;
    render(<JevCallPreference response={old} />);
    expect(screen.getByText('Call preference unavailable on this server.')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).toBeNull(); expect(posts).toEqual([]);
  });
  it('keeps read-only sessions read-only', async () => {
    writable = false; render(<JevCallPreference response={response()} />);
    await screen.findByText(/changes require a writable connection/);
    expect(screen.getByRole('button', { name: 'Save preference' })).toBeDisabled(); expect(posts).toEqual([]);
  });
  it('prompts through the existing gate and preserves the unsaved choice when unlock is cancelled', async () => {
    const user = await open(); clearMutationToken();
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Save preference' }));
    await screen.findByRole('dialog', { name: 'Unlock actions' });
    expect(posts).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('checkbox')).toBeChecked(); expect(posts).toEqual([]);
    expect(screen.queryByText(/Preference saved/)).toBeNull();
  });
});
