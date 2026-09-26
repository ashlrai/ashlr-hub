/**
 * ResourcesDrawer.test.tsx — the Resources drawer as the operator reads it
 * (unit 3.11 C6): one card per account in the shared wording, usable first;
 * the reserve kept for Mason; Reconnect / Check again through the token gate;
 * local compute with verified context windows and Start / Stop; cloud credits
 * as an ESTIMATE, or "Cloud lane not available yet" while the route 404s;
 * and the overlay's Esc / outside-click / focus contract and the pin.
 *
 * Instants are built in local time so "Sat 11:46 PM" holds in any zone.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SeatHealthReport } from '../../../../core/verse/health-types.js';
import { describeResetAt } from '../../../../core/verse/seat-readiness.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { capacity, CLAUDE_TIGHT_SEAT, GROK_SEAT, LOCAL_SEAT_V2, nativeSeat, seatWindow } from '../seat-fixtures.test-support.js';
import { resetGuard } from '../shell/guarded-action.js';
import { getVerseUiState, resetVerseUi } from '../verse-ui-store.js';
import { ResourcesDrawer } from './ResourcesDrawer.js';
import { getResourcesUi, openResources, reloadResourcesUiForTest } from './resources-store.js';

const TOKEN = 'test-token';
const NOW = new Date(2026, 8, 25, 16, 34).getTime(); // Fri Sep 25, 4:34 PM local
const EN_US = new Intl.DateTimeFormat().resolvedOptions().locale === 'en-US';
const RESET = new Date(2026, 8, 26, 23, 46).toISOString(); // Sat 11:46 PM local
const CHECKED = new Date(NOW - 2 * 60_000).toISOString();

const spentWindow = seatWindow({ id: 'codex_codex_primary', usedPercent: 100, resetsAt: RESET, limitReached: true, measured: false });
const PERSONAL = nativeSeat(capacity({ planType: 'plus', windows: [spentWindow], binding: spentWindow, usability: 'exhausted', observedAt: CHECKED }),
  { id: 'codex-personal', engine: 'codex', label: 'Personal Codex', accountId: 'codex-personal' });
const okWindow = seatWindow({ id: 'codex_codex_primary', usedPercent: 31, resetsAt: RESET });
const CMP = nativeSeat(capacity({ planType: 'pro', windows: [okWindow], binding: okWindow, usability: 'ready', observedAt: CHECKED }),
  { id: 'codex-cmp', engine: 'codex', label: 'Cash Margin Partners', accountId: 'codex-cmp' });
const CLAUDE = { ...CLAUDE_TIGHT_SEAT, id: 'claude-a', accountId: 'claude-a', label: 'Claude Max' };
const ROSTER = [PERSONAL, GROK_SEAT, CLAUDE, CMP, LOCAL_SEAT_V2];

function report(seatId: string, over: Partial<SeatHealthReport> = {}): SeatHealthReport {
  return {
    seatId, engine: 'codex', connection: 'connected', checkedAt: CHECKED, cliVersion: null, newestCliVersion: null,
    credentialExpiresAt: null, lastRefreshAt: null, resetAt: null, reasons: [], fix: { kind: 'none' }, ...over,
  };
}

const HEALTH: SeatHealthReport[] = [
  report('codex-personal', { connection: 'exhausted', resetAt: RESET, reasons: ['Every usage window with a reading is spent.'], fix: { kind: 'wait' } }),
  report('codex-cmp'),
  report('grok', { engine: 'grok', connection: 'signed-out', reasons: ['Grok CLI reports this account is not signed in.'], fix: { kind: 'reauth' } }),
  report('claude-a', { engine: 'claude' }),
];

const BUDGET = {
  mode: 'balanced',
  seats: {},
  updatedAt: CHECKED,
  headroom: [],
  seatInfo: [
    { seatId: 'claude-a', label: 'Claude Max', engine: 'claude', free: false },
    { seatId: 'codex-cmp', label: 'Cash Margin Partners', engine: 'codex', free: false },
  ],
  effective: {
    'claude-a': { seatId: 'claude-a', enabled: true, reservePercent: 40, maxSessionWindowPercent: 70 },
    'codex-cmp': { seatId: 'codex-cmp', enabled: false, reservePercent: 0 },
  },
  readingMaxAgeMs: 600_000,
  sampledAt: CHECKED,
};

const LOCAL_MODELS = {
  ollama: {
    reachable: true,
    models: [
      { name: 'qwen3:32b', loaded: true, nativeContext: 262_144, configuredContext: 65_536, capabilities: ['tools'] },
      { name: 'llama3.1:8b', loaded: false, nativeContext: 131_072, capabilities: ['tools'] },
    ],
  },
  machine: { totalMemoryBytes: 128 * 1024 ** 3, freeMemoryBytes: 64 * 1024 ** 3 },
};

const RUNTIME = {
  kind: 'llama-server', state: 'stopped', endpoint: '127.0.0.1:8080', model: 'Qwen3-32B', slotsTotal: null, slotsBusy: null, contextTokens: 16_384,
  startedAt: null, parallel: { capable: null, refusal: null, slots: null }, reason: null, supervised: true, sampledAt: null,
};

const CLOUD = {
  generatedAt: CHECKED,
  seat: { id: 'claude-a', ready: true, reason: null },
  budget: {
    creditsTotalUsd: 250, estimatedSpentUsd: 38, estimatedRemainingUsd: 212, sessionsToday: 5, selfImproveToday: 1, running: 2,
    canLaunch: { ok: true, reason: null }, canSelfImprove: { ok: true, reason: null },
    estimateNote: 'Estimated at $3 a session; the real balance is on claude.ai.', balanceUrl: 'https://claude.ai/settings/usage',
    budget: { maxSessionsPerDay: 20 },
  },
  tasks: [],
  backlog: { items: [], nextUp: null },
};

interface Call { method: string; url: string; body: unknown; token: string | null }
let calls: Call[];
let cloud: unknown;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
    calls.push({ method, url, body, token: new Headers(init?.headers).get('x-ashlr-token') });
    if (method === 'POST') {
      if (url === '/api/verse/health/refresh') return json({ checkedAt: CHECKED, seats: HEALTH });
      if (url === '/api/verse/health/reconnect') return json({ ok: true, seatId: (body as { seatId: string }).seatId }, 202);
      if (url === '/api/verse/runtime') return json({ ok: true, action: 'started', note: 'Starting llama-server.', runtime: null });
      return json({ error: 'nope' }, 404);
    }
    switch (url) {
      case '/api/verse/bootstrap':
        return json({ seats: ROSTER, projects: [], sessions: [], dispatchEnabled: true, localRuntime: {} });
      case '/api/verse/seats':
        return json({ sampledAt: CHECKED, seats: ROSTER, localRuntime: {} });
      case '/api/verse/health':
        return json({ checkedAt: CHECKED, seats: HEALTH });
      case '/api/verse/budget':
        return json(BUDGET);
      case '/api/verse/local-models':
        return json(LOCAL_MODELS);
      case '/api/verse/runtime':
        return json(RUNTIME);
      case '/api/verse/cloud':
        return cloud === 404 ? json({ error: 'not found' }, 404) : json(cloud);
      default:
        return json({ error: 'not found' }, 404);
    }
  }));
}

beforeEach(() => {
  localStorage.clear();
  evictAll();
  resetGuard();
  resetVerseUi();
  reloadResourcesUiForTest();
  setMutationToken(TOKEN);
  calls = [];
  cloud = 404;
  stubFetch();
});

afterEach(() => {
  clearMutationToken();
  vi.unstubAllGlobals();
});

const cardOf = (label: string) => screen.getByRole('heading', { name: new RegExp(`^${label}`) }).closest('li')!;

describe('ResourcesDrawer — accounts', () => {
  it('leads every account with the shared status wording, usable first', async () => {
    render(<ResourcesDrawer mode="docked" now={NOW} />);
    await screen.findByRole('heading', { name: /^Cash Margin Partners/ });
    const accounts = within(screen.getByRole('region', { name: 'Accounts' }));
    const names = accounts.getAllByRole('heading', { level: 4 }).map((h) => h.textContent);
    // usable (CMP) → tight (Claude) → spent (Personal) → signed out (Grok)
    expect(names.map((n) => n!.replace(/(max|pro|plus|SuperGrok)$/, ''))).toEqual(['Cash Margin Partners', 'Claude Max', 'Personal Codex', 'Grok']);

    expect(within(cardOf('Cash Margin Partners')).getByText('Connected')).toBeInTheDocument();
    expect(within(cardOf('Cash Margin Partners')).getByText('· usable now')).toBeInTheDocument();

    const spent = within(cardOf('Personal Codex'));
    expect(spent.getByText('Spent')).toBeInTheDocument();
    const when = describeResetAt(RESET, NOW)!;
    if (EN_US) expect(when).toBe('Sat 11:46 PM');
    expect(spent.getByText(`· resets ${when}`)).toBeInTheDocument();
    expect(spent.getByText('· usable again in 1d 7h')).toBeInTheDocument();
    expect(spent.getByText('checked 2m ago')).toBeInTheDocument();
    expect(spent.getByRole('button', { name: 'Check again: Personal Codex' })).toBeInTheDocument();

    const out = within(cardOf('Grok'));
    expect(out.getByText('Signed out')).toBeInTheDocument();
    expect(out.getByText('· reconnect to use it')).toBeInTheDocument();
    expect(out.getByRole('button', { name: 'Reconnect: Grok' })).toBeInTheDocument();
  });

  it('draws each window with the one percent rule and its reset, and the reserve kept for Mason', async () => {
    render(<ResourcesDrawer mode="docked" now={NOW} />);
    await screen.findByRole('heading', { name: /^Claude Max/ });
    await waitFor(() => expect(within(cardOf('Claude Max')).getByText('Reserved for you 40% · balanced mode')).toBeInTheDocument());
    const claude = within(cardOf('Claude Max'));
    expect(claude.getByText('92%')).toBeInTheDocument();
    expect(claude.getByText('15%')).toBeInTheDocument();
    expect(claude.getByRole('img', { name: /5-hour window: 15% used/ })).toBeInTheDocument();
    // The binding window carries the reserve in its sentence.
    expect(claude.getAllByRole('img').some((m) => /40% kept for you/.test(m.getAttribute('aria-label') ?? ''))).toBe(true);
    expect(within(cardOf('Personal Codex')).getByText('limit reached')).toBeInTheDocument();
  });

  it('Reconnect opens the provider sign-in through the token gate — the seat id only', async () => {
    const user = userEvent.setup();
    render(<ResourcesDrawer mode="docked" now={NOW} />);
    await user.click(await screen.findByRole('button', { name: 'Reconnect: Grok' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/api/verse/health/reconnect')).toBe(true));
    const post = calls.find((c) => c.url === '/api/verse/health/reconnect')!;
    expect(post.body).toEqual({ seatId: 'grok' });
    expect(post.token).toBe(TOKEN);
    expect(await screen.findByText(/Opened the sign-in for Grok in Terminal/)).toBeInTheDocument();
  });

  it('Check again runs the zero-cost health sweep', async () => {
    const user = userEvent.setup();
    render(<ResourcesDrawer mode="docked" now={NOW} />);
    await user.click(await screen.findByRole('button', { name: 'Check again: Personal Codex' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/api/verse/health/refresh')).toBe(true));
    expect(await screen.findByText('Checked Personal Codex again.')).toBeInTheDocument();
  });

  it('says so when no account is connected', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/verse/bootstrap') return json({ seats: [], projects: [], sessions: [], dispatchEnabled: true, localRuntime: {} });
      if (url === '/api/verse/seats') return json({ sampledAt: CHECKED, seats: [], localRuntime: {} });
      return json({ error: 'not found' }, 404);
    }));
    render(<ResourcesDrawer mode="docked" now={NOW} />);
    expect(await screen.findByText(/No accounts connected yet/)).toBeInTheDocument();
  });
});

describe('ResourcesDrawer — local', () => {
  it('shows the runtime, the context each model runs at, and starts a supervised runtime', async () => {
    const user = userEvent.setup();
    render(<ResourcesDrawer mode="docked" now={NOW} />);
    const local = within(await screen.findByRole('region', { name: 'Local' }));
    expect(await local.findByText('Qwen3 32B')).toBeInTheDocument();
    expect(local.getByTitle('qwen3:32b')).toBeInTheDocument();
    expect(local.getByText('64k of 256k context')).toBeInTheDocument();
    expect(local.getByText('128k context')).toBeInTheDocument();
    expect(local.getByText('Loaded')).toBeInTheDocument();
    expect(await local.findByText('llama-server')).toBeInTheDocument();
    expect(local.getByText('Stopped')).toBeInTheDocument();
    expect(local.getByText('Qwen3 32B · 16k context per agent')).toBeInTheDocument();
    await user.click(local.getByRole('button', { name: 'Start llama-server' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/api/verse/runtime')).toBe(true));
    expect(calls.find((c) => c.method === 'POST' && c.url === '/api/verse/runtime')!.body).toEqual({ action: 'start' });
    expect(await local.findByText('Starting llama-server.')).toBeInTheDocument();
  });
});

describe('ResourcesDrawer — cloud credits', () => {
  it('says "Cloud lane not available yet" while GET /api/verse/cloud 404s', async () => {
    render(<ResourcesDrawer mode="docked" now={NOW} />);
    const card = within(screen.getByRole('region', { name: 'Cloud' }));
    expect(await card.findByText('Cloud lane not available yet')).toBeInTheDocument();
    expect(card.queryByText(/\$/)).toBeNull();
  });

  it('shows the estimated remaining of the total, running sessions and the real-balance link', async () => {
    cloud = CLOUD;
    render(<ResourcesDrawer mode="docked" now={NOW} />);
    const card = within(screen.getByRole('region', { name: 'Cloud' }));
    expect(await card.findByText('$212 of $250 left')).toBeInTheDocument();
    expect(card.getByText('estimate')).toBeInTheDocument();
    expect(card.getByText('2 running · 5 of 20 today')).toBeInTheDocument();
    expect(card.getByText(/Estimated at \$3 a session/)).toBeInTheDocument();
    const link = card.getByRole('link', { name: /Real balance on claude\.ai/ });
    expect(link).toHaveAttribute('href', 'https://claude.ai/settings/usage');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('seat not set up: "Not set up" is the state and the credits read "~$250", never "$250 of $250 left"', async () => {
    cloud = {
      ...CLOUD,
      seat: { id: 'claude-a', ready: false, reason: "The Claude seat isn't set up on this Mac." },
      budget: { ...CLOUD.budget, estimatedSpentUsd: 0, estimatedRemainingUsd: 250, running: 0, sessionsToday: 0 },
    };
    render(<ResourcesDrawer mode="docked" now={NOW} />);
    const card = within(screen.getByRole('region', { name: 'Cloud' }));
    expect(await card.findByText('Not set up')).toBeInTheDocument();
    expect(card.getByText('· ~$250 credits')).toBeInTheDocument();
    expect(card.getByText('estimate')).toBeInTheDocument();
    expect(card.getByText("The Claude seat isn't set up on this Mac.")).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Cloud' }).textContent).not.toMatch(/of \$250 left/);
    expect(card.getByTitle('Cloud: not set up · ~$250 credits')).toBeInTheDocument();
    expect(card.getByRole('link', { name: /Real balance on claude\.ai/ })).toBeInTheDocument();
  });
});

describe('ResourcesDrawer — overlay', () => {
  it('is a labelled modal dialog that takes focus, closes on Esc and returns focus to its opener', async () => {
    const opener = document.createElement('button');
    opener.textContent = 'opener';
    document.body.appendChild(opener);
    opener.focus();
    openResources();
    const { unmount } = render(<ResourcesDrawer mode="overlay" now={NOW} />);
    const dialog = screen.getByRole('dialog', { name: 'Resources' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog.contains(document.activeElement)).toBe(true);
    act(() => { fireEvent.keyDown(document, { key: 'Escape' }); });
    expect(getResourcesUi().open).toBe(false);
    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('closes on a click outside the panel, not inside it', async () => {
    openResources();
    render(<ResourcesDrawer mode="overlay" now={NOW} />);
    const dialog = screen.getByRole('dialog', { name: 'Resources' });
    fireEvent.mouseDown(dialog);
    expect(getResourcesUi().open).toBe(true);
    fireEvent.mouseDown(dialog.parentElement!);
    expect(getResourcesUi().open).toBe(false);
  });

  it('keeps Esc for a dialog opened from the drawer (the token prompt)', async () => {
    openResources();
    render(<ResourcesDrawer mode="overlay" now={NOW} />);
    const foreign = document.createElement('div');
    foreign.setAttribute('aria-modal', 'true');
    document.body.appendChild(foreign);
    act(() => { fireEvent.keyDown(document, { key: 'Escape' }); });
    expect(getResourcesUi().open).toBe(true);
    foreign.remove();
  });

  it('pins from the overlay, and every icon button is named', async () => {
    const user = userEvent.setup();
    openResources();
    render(<ResourcesDrawer mode="overlay" now={NOW} />);
    for (const name of ['Read everything again', 'Pin resources beside the page', 'Close resources']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
    await user.click(screen.getByRole('button', { name: 'Pin resources beside the page' }));
    expect(getResourcesUi()).toMatchObject({ open: true, pinned: true });
  });

  it('cannot be pinned at phone width', () => {
    openResources();
    render(<ResourcesDrawer mode="overlay" compact now={NOW} />);
    expect(screen.queryByRole('button', { name: /Pin resources/ })).toBeNull();
  });

  it('docked, it is a complementary region (no trap) with an Unpin toggle', async () => {
    const user = userEvent.setup();
    render(<ResourcesDrawer mode="docked" now={NOW} />);
    expect(screen.getByRole('complementary', { name: 'Resources' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    const unpin = screen.getByRole('button', { name: 'Unpin resources' });
    expect(unpin).toHaveAttribute('aria-pressed', 'true');
    await user.click(unpin);
    expect(getResourcesUi().pinned).toBe(false);
  });

  it('closes a floating drawer when it navigates to Apps', async () => {
    const user = userEvent.setup();
    openResources();
    render(<ResourcesDrawer mode="overlay" now={NOW} />);
    await user.click(screen.getByRole('button', { name: 'Apps & Accounts' }));
    expect(getResourcesUi().open).toBe(false);
    expect(getVerseUiState().section).toBe('apps');
  });
});
