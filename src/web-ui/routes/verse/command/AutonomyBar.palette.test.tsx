/**
 * ⌘K "Autonomy: …", "Approve grant…" and "Budget mode: …" run THROUGH
 * Command's AutonomyBar — against the real surface, the real authority and
 * budget reads, and the real POSTs — so the palette is pinned to the bar's
 * own rules: lowering is instant, raising past the grant opens the Touch ID
 * sheet and sends nothing, the grant ceiling clamps the budget, a missing
 * token asks for it first, and a surface that cannot act says why.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { CommandSection } from '../sections/CommandSection.js';
import { resetCommandBus } from '../shell/command-bus.js';
import { executeCatalogCommand, setShellNotifier } from '../shell/run-command.js';
import { resetActivityForTest } from '../shell/useActivity.js';
import { mockWideViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { getVerseUiState, resetVerseUi, setVerseSection } from '../verse-ui-store.js';
import { stubSurfaceFetch } from './fetch-stub.test-support.js';
import { authorityStatus, budgetView } from './fixtures.test-support.js';

const TOKEN = 'a'.repeat(64);
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

let vp: ViewportMock | null = null;
const notify = vi.fn();

beforeEach(() => {
  evictAll();
  resetActivityForTest();
  resetCommandBus();
  resetVerseUi();
  clearMutationToken();
  notify.mockReset();
  setShellNotifier(notify);
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
  vp = mockWideViewport();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearMutationToken();
  setShellNotifier(null);
  vp?.restore();
  vp = null;
});

async function ready() {
  await waitFor(() => expect(screen.getByTestId('verdict')).toHaveTextContent(/building|dark|Propose|unknown/));
}

function run(id: string) {
  act(() => {
    executeCatalogCommand(id, { via: 'palette' });
  });
}

describe('⌘K autonomy switch', () => {
  it('lowers at once from another surface: Command comes forward, the parked command runs, one POST', async () => {
    setMutationToken(TOKEN);
    const { posted } = stubSurfaceFetch({ kind: 'live', post: () => json(authorityStatus('live', Date.now(), { switch: 'off', effectiveSwitch: 'off' })) });
    setVerseSection('chat');
    // Asked before Command has ever mounted: it parks until the bar registers.
    run('autonomy.off');
    expect(getVerseUiState().section).toBe('command');
    render(<CommandSection />);
    await waitFor(() => expect(posted).toEqual([{ url: '/api/verse/authority', body: { action: 'switch', to: 'off' } }]));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('raising past the grant opens the Touch ID sheet and sends nothing', async () => {
    setMutationToken(TOKEN);
    const { posted } = stubSurfaceFetch({ kind: 'sparse' });
    render(<CommandSection />);
    await ready();
    run('autonomy.autonomous');
    expect(await screen.findByRole('dialog', { name: 'Approve a standing grant' })).toHaveTextContent(
      'Autonomous is beyond what the installed grant allows, so it needs a new grant.',
    );
    expect(posted).toEqual([]);
  });

  it('says it is already there instead of posting a no-op', async () => {
    setMutationToken(TOKEN);
    const { posted } = stubSurfaceFetch({ kind: 'live' });
    render(<CommandSection />);
    await ready();
    run('autonomy.autonomous');
    expect(notify).toHaveBeenCalledWith('Autonomy is already Autonomous.', 'neutral');
    expect(posted).toEqual([]);
  });

  it('asks for the mutation token first when none is held', async () => {
    const { posted } = stubSurfaceFetch({ kind: 'live' });
    render(<CommandSection />);
    await ready();
    run('autonomy.propose');
    expect(await screen.findByRole('dialog', { name: 'Unlock actions' })).toBeInTheDocument();
    expect(posted).toEqual([]);
  });

  it('says why when the authority service is not there, and changes nothing', async () => {
    setMutationToken(TOKEN);
    const { posted } = stubSurfaceFetch({ kind: 'live', routes: { '/api/verse/authority': null } });
    render(<CommandSection />);
    await waitFor(() => expect(screen.getByTestId('verdict')).toBeInTheDocument());
    run('autonomy.off');
    await waitFor(() => expect(notify).toHaveBeenCalledWith(expect.stringMatching(/authority service is not in this build/), 'neutral'));
    expect(posted).toEqual([]);
  });
});

describe('⌘K Approve grant…', () => {
  it('opens the sheet when there is no grant', async () => {
    setMutationToken(TOKEN);
    const { posted } = stubSurfaceFetch({ kind: 'dark' });
    render(<CommandSection />);
    await ready();
    run('autonomy.grant');
    expect(await screen.findByRole('dialog', { name: 'Approve a standing grant' })).toBeInTheDocument();
    expect(posted).toEqual([]);
  });

  it('re-approves a paused grant', async () => {
    const now = Date.now();
    const live = authorityStatus('live', now);
    stubSurfaceFetch({ kind: 'live', now, routes: { '/api/verse/authority': { ...live, grant: { ...live.grant, state: 'paused', reason: 'Authority code changed — re-approve.' } } } });
    render(<CommandSection />);
    await ready();
    run('autonomy.grant');
    expect(await screen.findByRole('dialog', { name: 'Re-approve the standing grant' })).toHaveTextContent('Authority code changed — re-approve.');
  });

  it('with an active grant weeks from expiry, says so rather than drafting a replacement', async () => {
    stubSurfaceFetch({ kind: 'live' });
    render(<CommandSection />);
    await ready();
    run('autonomy.grant');
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/^Grant active until /), 'neutral');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('⌘K Budget mode', () => {
  it('sets a mode inside the grant ceiling through the budget route', async () => {
    setMutationToken(TOKEN);
    const { posted } = stubSurfaceFetch({ kind: 'live', post: (url) => (url === '/api/verse/budget' ? json({ ...budgetView('live'), mode: 'reserve' }) : undefined) });
    render(<CommandSection />);
    await ready();
    run('budget.reserve');
    await waitFor(() => expect(posted).toEqual([{ url: '/api/verse/budget', body: { mode: 'reserve' } }]));
    await waitFor(() => expect(notify).toHaveBeenCalledWith('Budget set to Reserve.', 'success'));
  });

  it('refuses a mode above the grant’s ceiling, naming the ceiling', async () => {
    setMutationToken(TOKEN);
    const { posted } = stubSurfaceFetch({ kind: 'live' });
    render(<CommandSection />);
    await ready();
    run('budget.all-in');
    expect(notify).toHaveBeenCalledWith(
      'Your grant allows up to Balanced, so All-in is unavailable. A new grant can raise the ceiling.',
      'neutral',
    );
    expect(posted).toEqual([]);
  });

  it('says the mode is already set', async () => {
    const { posted } = stubSurfaceFetch({ kind: 'live' });
    render(<CommandSection />);
    await ready();
    await waitFor(() => expect(screen.getByRole('button', { name: /Budget/ })).toHaveTextContent('Balanced'));
    run('budget.balanced');
    expect(notify).toHaveBeenCalledWith('Budget is already Balanced.', 'neutral');
    expect(posted).toEqual([]);
  });
});
