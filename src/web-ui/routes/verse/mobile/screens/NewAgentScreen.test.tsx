/**
 * New agent on the phone: loading / error / empty / no-seat states, the repo
 * and seat pickers, a single start (no sheet, then session, then first turn, then the
 * chat), a multi-seat start (confirmed, one session per seat, then Agents), a
 * partial failure that keeps the prompt, and Start hidden or disabled when
 * the device cannot act or the Mac is out of reach.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerseBootstrap, VerseSeat } from '../../../../data/api-types.js';
import { clearMutationToken, setMutationToken } from '../../../../data/auth-store.js';
import { evictAll } from '../../../../data/cache.js';
import { resetGuard } from '../../shell/guard-store.js';
import { MobileGuardSheet } from '../MobileGuardSheet.js';
import { MobileToasts, resetMobileToastsForTest } from '../mobile-toast.js';
import { json, permissionsFor, renderMobile, stubFetch, TOKEN } from '../mobile.test-support.js';
import { NewAgentScreen } from './NewAgentScreen.js';

function seat(id: string, engine: VerseSeat['engine'], label: string, over: Partial<VerseSeat> = {}): VerseSeat {
  return {
    id,
    engine,
    label,
    accountId: id,
    models: [
      { id: `${id}-m1`, label: `${label} default`, contextWindow: 200_000 },
      { id: `${id}-m2`, label: `${label} big`, contextWindow: 1_000_000 },
      { id: `${id}-old`, label: `${label} next`, contextWindow: null, unavailableReason: 'needs a newer CLI' },
    ],
    contextWindow: 200_000,
    health: { state: 'ready', summary: null, windows: [], observedAt: null },
    ...over,
  };
}

const SEATS = [
  seat('grok', 'grok', 'Grok'),
  seat('claude', 'claude', 'Claude Code'),
  seat('codex', 'codex', 'Codex', { health: { state: 'unavailable', summary: 'signed out of Codex', windows: [], observedAt: null } }),
];

function bootstrap(over: Partial<VerseBootstrap> = {}): VerseBootstrap {
  return {
    seats: SEATS,
    projects: [
      { path: '/Users/me/code/hub', name: 'hub', enrolled: true },
      { path: '/Users/me/code/site', name: 'site', enrolled: false },
    ],
    sessions: [],
    dispatchEnabled: true,
    localRuntime: null,
    ...over,
  } as unknown as VerseBootstrap;
}

function routes(boot: VerseBootstrap | Response = bootstrap(), extra: Record<string, unknown> = {}) {
  let n = 0;
  return stubFetch({
    'GET /api/verse/bootstrap': boot,
    'POST /api/verse/sessions': (body: Record<string, unknown> | null) => ({ id: `s-${String(body?.['seatId'])}-${++n}` }),
    ...Object.fromEntries(['claude', 'grok'].flatMap((s) => [1, 2, 3].map((i) => [`POST /api/verse/sessions/s-${s}-${i}/turns`, { ok: true }]))),
    ...extra,
  });
}

function mount(overrides: Parameters<typeof renderMobile>[1] = {}) {
  return renderMobile(
    <>
      <NewAgentScreen />
      <MobileGuardSheet />
      <MobileToasts />
    </>,
    overrides,
  );
}

async function typePrompt(text: string) {
  const box = await screen.findByRole('textbox', { name: 'What should the agent do?' });
  fireEvent.change(box, { target: { value: text } });
}

beforeEach(() => {
  setMutationToken(TOKEN);
});

afterEach(() => {
  clearMutationToken();
  evictAll();
  resetGuard();
  resetMobileToastsForTest();
  vi.unstubAllGlobals();
});

describe('NewAgentScreen states', () => {
  it('shows skeletons in the shape of the pickers while the bootstrap loads', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    mount();
    expect(screen.getByRole('status', { name: 'Loading repos' })).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Loading seats' })).toBeInTheDocument();
  });

  it('says why the bootstrap failed, with Try again', async () => {
    const stub = routes(json({ error: 'The seat collector crashed.' }, 500));
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent('The seat collector crashed.');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(stub.calls.filter((c) => c.url === '/api/verse/bootstrap').length).toBe(2));
  });

  it('points at enrollment when there are no repos', async () => {
    routes(bootstrap({ projects: [] }));
    mount();
    expect(await screen.findByText('No repos yet')).toBeInTheDocument();
    expect(screen.getByText(/ashlr verse/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Start/ })).not.toBeInTheDocument();
  });

  it('says no seat can run, and why each cannot', async () => {
    routes(bootstrap({ seats: [SEATS[2]!] }));
    mount();
    expect(await screen.findByText('No seat can run right now')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Seats that can’t run' })).toHaveTextContent('Codex: signed out of Codex');
    expect(screen.getByRole('button', { name: 'Start agent' })).toBeDisabled();
    expect(screen.getByText('Choose a seat that can run.')).toBeInTheDocument();
  });
});

describe('NewAgentScreen pickers', () => {
  it('lists enrolled repos first, preselects one, and filters', async () => {
    routes();
    mount();
    const hub = await screen.findByRole('radio', { name: /hub/ });
    expect(hub).toHaveAttribute('aria-checked', 'true');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find a repo' }), { target: { value: 'sit' } });
    expect(screen.queryByRole('radio', { name: /hub/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /site/ }));
    expect(screen.getByRole('radio', { name: /site/ })).toHaveAttribute('aria-checked', 'true');
  });

  it('orders seats Claude, Codex, Grok; disables the unavailable one; lists runnable models', async () => {
    routes();
    mount();
    const group = await screen.findByRole('group', { name: 'Seat' });
    const chips = within(group).getAllByRole('button');
    expect(chips.map((c) => c.textContent)).toEqual(['Claude Code', 'Codex', 'Grok']);
    expect(chips[0]).toHaveAttribute('aria-pressed', 'true');
    expect(chips[1]).toBeDisabled();
    const select = screen.getByRole('combobox', { name: 'Model' });
    expect(within(select).getByRole('option', { name: 'Claude Code next — needs a newer CLI' })).toBeDisabled();
  });
});

describe('NewAgentScreen start', () => {
  it('one seat: no sheet — creates the session, sends the prompt, opens the chat', async () => {
    const stub = routes();
    const { context } = mount();
    await typePrompt('Fix the flaky snapshot test');
    fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), { target: { value: 'claude-m2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start agent' }));
    await waitFor(() => expect(context.navigate).toHaveBeenCalledWith({ screen: 'agent', id: 's-claude-1', pane: 'transcript' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    const posts = stub.posts();
    expect(posts.map((p) => p.url)).toEqual(['/api/verse/sessions', '/api/verse/sessions/s-claude-1/turns']);
    expect(posts[0]!.body).toEqual({ projectPath: '/Users/me/code/hub', seatId: 'claude', model: 'claude-m2' });
    expect(posts[1]!.body).toEqual({ text: 'Fix the flaky snapshot test' });
    expect(posts[0]!.headers['x-ashlr-token']).toBe(TOKEN);
  });

  it('several seats: confirms with what will happen, then starts one agent per seat', async () => {
    const stub = routes();
    const { context } = mount();
    await typePrompt('Audit the router');
    fireEvent.click(screen.getByRole('switch', { name: /Spawn on several seats/ }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Seats' })).getByRole('button', { name: 'Grok' }));
    expect(screen.getByText('Starts 2 agents in hub.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start 2 agents' }));
    const sheet = await screen.findByRole('alertdialog');
    expect(sheet).toHaveTextContent('Starts 2 agents on Claude Code and Grok in hub; each spends from its own seat.');
    expect(stub.posts()).toHaveLength(0);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Start 2 agents' }));
    await waitFor(() => expect(context.navigate).toHaveBeenCalledWith({ screen: 'agents' }));
    const creates = stub.posts().filter((p) => p.url === '/api/verse/sessions');
    expect(creates.map((p) => p.body?.['seatId']).sort()).toEqual(['claude', 'grok']);
    expect(creates.find((p) => p.body?.['seatId'] === 'grok')?.body?.['model']).toBe('grok-m1');
    expect(stub.posts().filter((p) => p.url.endsWith('/turns'))).toHaveLength(2);
    expect(screen.getByText('Started 2 agents')).toBeInTheDocument();
  });

  it('partial failure: says which seat failed, keeps the prompt and leaves only that seat selected', async () => {
    routes(bootstrap(), {
      'POST /api/verse/sessions': (body: Record<string, unknown> | null) =>
        body?.['seatId'] === 'grok' ? json({ error: 'Grok is out of usage.' }, 409) : { id: 's-claude-1' },
    });
    const { context } = mount();
    await typePrompt('Audit the router');
    fireEvent.click(screen.getByRole('switch', { name: /Spawn on several seats/ }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Seats' })).getByRole('button', { name: 'Grok' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start 2 agents' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Start 2 agents' }));
    expect(await screen.findByText(/Started 1 of 2 agents\. Grok: Grok is out of usage\./)).toBeInTheDocument();
    expect(context.navigate).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'What should the agent do?' })).toHaveValue('Audit the router');
    const group = screen.getByRole('group', { name: 'Seats' });
    expect(within(group).getByRole('button', { name: 'Grok' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(group).getByRole('button', { name: 'Claude Code' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('a single start that fails says why and stays put with the prompt', async () => {
    routes(bootstrap(), { 'POST /api/verse/sessions': () => json({ error: 'Claude Code is signed out.' }, 409) });
    const { context } = mount();
    await typePrompt('Do the thing');
    fireEvent.click(screen.getByRole('button', { name: 'Start agent' }));
    expect(await screen.findByText('Claude Code is signed out.')).toBeInTheDocument();
    expect(context.navigate).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'What should the agent do?' })).toHaveValue('Do the thing');
  });

  it('asks for the token first when actions are locked', async () => {
    clearMutationToken();
    const stub = routes();
    mount({ permissions: permissionsFor('locked') });
    await typePrompt('Do the thing');
    fireEvent.click(screen.getByRole('button', { name: 'Start agent' }));
    expect(await screen.findByRole('dialog', { name: 'Unlock actions' })).toBeInTheDocument();
    expect(stub.posts()).toHaveLength(0);
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Mutation token'), { target: { value: TOKEN } });
      fireEvent.click(screen.getByRole('button', { name: /Unlock and start agent/ }));
    });
    await waitFor(() => expect(stub.posts()).toHaveLength(2));
  });

  it('is disabled until there is a prompt', async () => {
    routes();
    mount();
    expect(await screen.findByRole('button', { name: 'Start agent' })).toBeDisabled();
    expect(screen.getByText('Say what the agent should do.')).toBeInTheDocument();
  });

  it('hides Start and says why when this device cannot act', async () => {
    routes();
    mount({ permissions: permissionsFor('unavailable') });
    expect(await screen.findByText('Your Mac started Verse without dispatch.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Start/ })).not.toBeInTheDocument();
  });

  it('disables Start while the Mac is out of reach', async () => {
    routes();
    mount({ reachability: 'unreachable' });
    await typePrompt('Do the thing');
    expect(screen.getByRole('button', { name: 'Start agent' })).toBeDisabled();
    expect(screen.getByText(/Offline — starting waits/)).toBeInTheDocument();
  });
});
