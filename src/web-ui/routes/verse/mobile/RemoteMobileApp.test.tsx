import { act, fireEvent, render, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { markCheckComplete } from '../../../data/auth-store.js';
import type { RemoteSession } from '../../../data/remote-session.js';
import { RemoteMobileApp } from './RemoteMobileApp.js';
import { Button, ui } from './ui.js';

const { probe } = vi.hoisted(() => ({ probe: vi.fn() }));
vi.mock('../../../data/remote-session.js', async (original) => ({
  ...await original<typeof import('../../../data/remote-session.js')>(),
  probeRemoteSession: probe,
}));

function ready(): RemoteSession {
  return { authenticated: true, deviceId: 'phone', label: 'Phone', csrfToken: 'c'.repeat(40),
    capabilities: { writes: true, pairing: true, push: false }, scopes: { read: true, act: true },
    expiresAt: Date.now() + 60_000 };
}
const signedOut: RemoteSession = { authenticated: false, csrfToken: 'c'.repeat(40),
  capabilities: { writes: false, pairing: false, push: false } };

const mounted = vi.fn();
function DraftScreen() {
  const [draft, setDraft] = useState('');
  useEffect(() => { mounted(); }, []);
  return <input aria-label="Draft" value={draft} onChange={(e) => setDraft(e.target.value)} />;
}
async function mount() {
  render(<RemoteMobileApp shell={<DraftScreen />} Button={Button} ui={ui} />);
  await act(async () => {});
  fireEvent.change(screen.getByRole('textbox', { name: 'Draft' }), { target: { value: 'Keep these words' } });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-29T12:00:00Z'));
  probe.mockReset();
  mounted.mockClear();
  localStorage.clear();
  sessionStorage.clear();
  markCheckComplete(false);
});
afterEach(() => { act(() => markCheckComplete(false)); vi.useRealTimers(); });

describe('phone session checks', () => {
  it('preserves the screen and its draft while checking a valid cookie, without repeated probes', async () => {
    const session = ready();
    let answer!: (next: RemoteSession) => void;
    probe.mockResolvedValueOnce(session).mockImplementationOnce(() => new Promise<RemoteSession>((resolve) => { answer = resolve; }));
    await mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(55_000); });
    expect(probe).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('textbox', { name: 'Draft' })).toHaveValue('Keep these words');
    await act(async () => { answer(session); });
    await act(async () => { await vi.advanceTimersByTimeAsync(4_999); });
    expect(probe).toHaveBeenCalledTimes(2);
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('textbox', { name: 'Draft' })).toHaveValue('Keep these words');
  });

  it('locks at the deadline even while a check is stalled, and ignores its late authenticated result', async () => {
    const session = ready();
    let answer!: (next: RemoteSession) => void;
    probe.mockResolvedValueOnce(session)
      .mockImplementationOnce(() => new Promise<RemoteSession>((resolve) => { answer = resolve; }))
      .mockResolvedValueOnce(signedOut);
    await mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(screen.queryByRole('textbox', { name: 'Draft' })).not.toBeInTheDocument();
    expect(screen.getByText(/Phone pairing is not enabled/)).toBeInTheDocument();
    await act(async () => { answer(session); });
    expect(screen.queryByRole('textbox', { name: 'Draft' })).not.toBeInTheDocument();
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('closes the shell when the gateway revokes the device during its check', async () => {
    probe.mockResolvedValueOnce(ready()).mockRejectedValueOnce(new Error('Device revoked'));
    await mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(55_000); });
    expect(screen.queryByRole('textbox', { name: 'Draft' })).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('does not reopen the shell when a check answers after sign-out', async () => {
    const session = ready();
    let answer!: (next: RemoteSession) => void;
    probe.mockResolvedValueOnce(session)
      .mockImplementationOnce(() => new Promise<RemoteSession>((resolve) => { answer = resolve; }))
      .mockResolvedValueOnce(signedOut);
    await mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(55_000); });
    await act(async () => { markCheckComplete(false); });
    await act(async () => { answer(session); });
    expect(screen.queryByRole('textbox', { name: 'Draft' })).not.toBeInTheDocument();
  });
});
