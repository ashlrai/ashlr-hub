/**
 * ResourcesDrawer.test.tsx — the Resources drawer as the operator reads it
 * (unit 3.11 C6): one card per account in the shared wording, stable roster order;
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
import { evictAll, getQuerySnapshot, runQuery } from '../../../data/cache.js';
import { ApiError } from '../../../data/client.js';
import { capacity, CLAUDE_TIGHT_SEAT, GROK_SEAT, LOCAL_SEAT_V2, nativeSeat, seatWindow } from '../seat-fixtures.test-support.js';
import { resetGuard } from '../shell/guarded-action.js';
import { getVerseUiState, resetVerseUi, setVerseActiveSession, VERSE_ANCHOR_EVENT, type VerseAnchorRequest } from '../verse-ui-store.js';
import { verseBootstrapQuery } from '../verse-queries.js';
import { budgetQuery } from '../budget/budget-queries.js';
import { ResourcesBar } from './ResourcesBar.js';
import { ResourcesDrawer } from './ResourcesDrawer.js';
import { verseAccountsQuery, verseLocalModelsQuery } from '../usage/usage-queries.js';
import { resourceReadinessQuery } from './resources-queries.js';
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

/** GET /api/verse/budget/readiness (3.14), shaped like the machine as diagnosed on 2026-09-26. */
const SETUP_COMMAND = 'ashlr resources profile prepare --provider claude --directory ~/.ashlr/native-profiles/claude-a --executable "$(realpath "$(command -v claude)")"';
const READINESS = {
  v: 1,
  checkedAt: CHECKED,
  autonomy: { active: true, stage: 'shadow', detail: 'Stage 1 of 8 · shadow' },
  capacitySnapshotAt: CHECKED,
  resources: [
    {
      id: 'codex-cmp', label: 'Cash Margin Partners', engine: 'codex', kind: 'subscription',
      reading: { state: 'live', at: CHECKED, note: null },
      chat: { ready: true, tone: 'ok', word: 'Ready', detail: '', fix: null },
      fleet: { ready: false, tone: 'off', word: 'Not in this stage', detail: 'The rollout is at stage 1 of 8 (shadow); the Codex lane opens at stage 5 (3a).', fix: null, roles: ['producer', 'judge'], reservePercent: null },
    },
    {
      id: 'claude-a', label: 'Claude Max', engine: 'claude', kind: 'subscription',
      reading: { state: 'live', at: CHECKED, note: null },
      chat: { ready: true, tone: 'ok', word: 'Ready', detail: '', fix: null },
      fleet: { ready: true, tone: 'ok', word: 'Ready', detail: '35% of the weekly window is left for the fleet. Roles: judges, leads.', fix: null, roles: ['judge', 'leader'], reservePercent: 40 },
    },
    {
      id: 'personal-last', label: 'Personal Codex', engine: 'codex', kind: 'subscription',
      reading: { state: 'last', at: new Date(NOW - 3 * 3_600_000).toISOString(), note: 'Polling is paused because nothing has asked for account data recently; it resumes the moment Verse is looked at.' },
      chat: { ready: true, tone: 'warn', word: 'Ready', detail: 'No current usage reading — the provider decides at send time.', fix: { kind: 'check-again', label: 'Check again', seatId: 'codex-personal' } },
      fleet: { ready: false, tone: 'blocked', word: 'No reading', detail: 'No usage reading for this seat — unknown usage is not headroom, so autonomy stays off it.', fix: null, roles: ['producer', 'judge'], reservePercent: 40 },
    },
    {
      id: 'local', label: 'Local models', engine: 'local', kind: 'local',
      reading: { state: 'live', at: CHECKED, note: null },
      chat: { ready: true, tone: 'ok', word: 'Ready', detail: 'qwen3:32b.', fix: null },
      fleet: { ready: true, tone: 'ok', word: 'Ready', detail: 'Free — no usage window to protect. Roles: builds, leads.', fix: null, roles: ['producer', 'leader'], reservePercent: null },
    },
    {
      id: 'cloud', label: 'Claude cloud', engine: 'claude', kind: 'cloud',
      reading: { state: 'live', at: CHECKED, note: 'About $212 of $250 in estimated credits left.' },
      chat: {
        ready: false, tone: 'blocked', word: 'Not set up', detail: "The Claude seat isn't set up on this Mac. Create the claude-a profile, then sign it in with the command it prints.",
        fix: { kind: 'command', label: 'Set up the Claude seat', command: SETUP_COMMAND },
      },
      fleet: { ready: false, tone: 'off', word: 'Off', detail: 'Self-improvement is off — cloud sessions run only when you launch them.', fix: null, roles: [], reservePercent: null },
    },
  ],
};

interface Call { method: string; url: string; body: unknown; token: string | null }
let calls: Call[];
let cloud: unknown;
let readiness: unknown;
let readinessResponse: (() => Promise<Response>) | null;
let accountsResponse: (() => Promise<Response>) | null;
let localModels: unknown;
let devin: unknown;
let roster: unknown[];
let budget: unknown;

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
      if (url === '/api/verse/seats/refresh') return json({ seatId: (body as { seatId: string }).seatId, state: 'completed', reading: 'unknown', reason: 'usage-not-reported', observedAt: null, expiresAt: null, nextCheckAt: null, joined: false });
      if (url === '/api/verse/health/refresh') return json({ checkedAt: CHECKED, seats: HEALTH });
      if (url === '/api/verse/health/reconnect') return json({ ok: true, seatId: (body as { seatId: string }).seatId }, 202);
      if (url === '/api/verse/runtime') return json({ ok: true, action: 'started', note: 'Starting llama-server.', runtime: null });
      return json({ error: 'nope' }, 404);
    }
    switch (url) {
      case '/api/verse/bootstrap':
        return json({ seats: roster, projects: [], sessions: [], dispatchEnabled: true, localRuntime: {} });
      case '/api/verse/seats':
        return json({ sampledAt: CHECKED, seats: roster, localRuntime: {} });
      case '/api/verse/devin':
        return devin === 404 ? json({ error: 'not found' }, 404) : json(devin);
      case '/api/verse/health':
        return json({ checkedAt: CHECKED, seats: HEALTH });
      case '/api/verse/budget':
        return json(budget);
      case '/api/verse/local-models':
        return json(localModels);
      case '/api/verse/budget/readiness':
        if (readinessResponse) return readinessResponse();
        return readiness === 404 ? json({ error: 'not found' }, 404) : json(readiness);
      case '/api/verse/accounts':
        return accountsResponse ? accountsResponse() : json({ error: 'not found' }, 404);
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
  readiness = 404;
  readinessResponse = null;
  accountsResponse = null;
  localModels = LOCAL_MODELS;
  devin = 404;
  roster = ROSTER;
  budget = BUDGET;
  stubFetch();
});

afterEach(() => {
  clearMutationToken();
  vi.unstubAllGlobals();
});

const cardOf = (label: string) => screen.getByRole('heading', { name: new RegExp(`^${label}`) }).closest('li')!;

describe('ResourcesDrawer — usage collection', () => {
  const HELD = 'Usage collection is held. Readings may be historical; Chat sign-in and Fleet permission are separate.';
  const blocked = { sampledAt: CHECKED, collector: {
    mode: 'owned', state: 'blocked', owner: 'this-server', reasonCode: 'collector-unavailable',
    note: 'Waiting for cleanup', lastPolledAt: CHECKED,
  } };

  it('explains held collection while preserving separate Chat and Fleet verdicts, without actions', async () => {
    accountsResponse = async () => json(blocked);
    readiness = READINESS;
    render(<ResourcesDrawer mode="docked" now={NOW} />);
    expect(await screen.findByText(HELD)).toBeInTheDocument();
    const status = await screen.findByRole('group', { name: 'Cash Margin Partners: readiness' });
    expect(within(status).getByText('Ready')).toBeInTheDocument();
    expect(within(status).getByText('Not in this stage')).toBeInTheDocument();
    expect(calls.every(call => call.method === 'GET')).toBe(true);
    expect(screen.queryByText('collector-unavailable')).toBeNull();
  });

  it('labels retained collection as last during refresh and never presents failed evidence as current', async () => {
    accountsResponse = async () => json(blocked);
    render(<ResourcesDrawer mode="docked" now={NOW} />);
    await screen.findByText(HELD);
    let complete!: (response: Response) => void;
    accountsResponse = () => new Promise(resolve => { complete = resolve; });
    fireEvent.click(screen.getByRole('button', { name: 'Read everything again' }));
    await waitFor(() => expect(getQuerySnapshot(verseAccountsQuery.key).status).toBe('refreshing'));
    expect(screen.queryByText(HELD)).toBeNull();
    expect(screen.getByText(`Last collection status · ${HELD} Checking again…`)).toBeInTheDocument();
    await act(async () => { complete(json({ error: 'expired' }, 401)); });
    expect(await screen.findByText('Usage collection status is unavailable · sign in again.')).toBeInTheDocument();
    expect(getQuerySnapshot(verseAccountsQuery.key).data).toEqual({ available: true, raw: blocked, reason: null });
    accountsResponse = async () => json({ collector: { ...blocked.collector, state: 'running', reasonCode: null } });
    await act(async () => { await runQuery(verseAccountsQuery.key, () => verseAccountsQuery.fetch()); });
    expect(screen.queryByText(HELD)).toBeNull();
    expect(screen.queryByText(/Usage collection status is unavailable/)).toBeNull();
    expect(calls.every(call => call.method === 'GET')).toBe(true);
  });

  it('describes shared ownership without treating another process as sign-out or a measured quota', async () => {
    accountsResponse = async () => json({ collector: {
      ...blocked.collector, mode: 'read-only', owner: 'another-collector', reasonCode: 'collector-owned',
    } });
    render(<ResourcesDrawer mode="docked" now={NOW} />);
    expect(await screen.findByText('Another Phantom process owns usage collection; this view depends on its shared readings.')).toBeInTheDocument();
    expect(screen.queryByText(HELD)).toBeNull();
    expect(calls.every(call => call.method === 'GET')).toBe(true);
  });

  it('distinguishes normal idle lease handoff from a held collection', async () => {
    accountsResponse = async () => json({ collector: {
      ...blocked.collector, mode: 'read-only', state: 'suspended', owner: 'none', reasonCode: 'connection-polling-paused',
    } });
    render(<ResourcesDrawer mode="docked" now={NOW} />);
    expect(await screen.findByText('Usage collection is paused while idle.')).toBeInTheDocument();
    expect(screen.queryByText(HELD)).toBeNull();
    expect(calls.every(call => call.method === 'GET')).toBe(true);
  });

  it.each([
    { collector: { ...blocked.collector, mode: { toString: 1 } } },
    { collector: { ...blocked.collector, owner: 'none' } },
    { collector: null },
    {},
  ])('reports malformed ownership as unavailable without inventing collection state', async body => {
    accountsResponse = async () => json(body);
    render(<ResourcesDrawer mode="docked" now={NOW} />);
    expect(await screen.findByText('Usage collection status is unavailable.')).toBeInTheDocument();
    expect(screen.queryByText(HELD)).toBeNull();
  });
});

describe('ResourcesDrawer — accounts', () => {
  it('names unconfirmed usage separately from known connection and native Chat/Fleet readiness', async () => {
    const unknown = { ...CMP, capacity: { ...CMP.capacity!, windows: [], binding: null, usability: 'unknown' as const } };
    roster = [unknown, LOCAL_SEAT_V2];
    readiness = READINESS;
    render(<ResourcesDrawer mode="docked" now={NOW} />);
    expect(await screen.findByText('0 of 1 account with current usage · 1 usage unconfirmed · local models ready')).toBeInTheDocument();
    const status = await screen.findByRole('group', { name: 'Cash Margin Partners: readiness' });
    expect(within(status).getByText('Ready')).toBeInTheDocument();
    expect(within(status).getByText('Not in this stage')).toBeInTheDocument();
    expect(within(cardOf('Cash Margin Partners')).getByText('· no usage reading yet')).toBeInTheDocument();
    expect(calls.every(call => call.method === 'GET')).toBe(true);
    expect(unknown.capacity.windows).toEqual([]);
  });

  it('discloses current native credit units and qualified dollar value without admitting Fleet spending', async () => {
    const creditAccount = { ...PERSONAL, capacity: { ...PERSONAL.capacity!,
      credits: { hasCredits: true, unlimited: false, balance: '2500.0000', spendControlReached: false },
      creditsExpiresAt: new Date(NOW + 30_000).toISOString(),
    } };
    roster = [creditAccount];
    render(<ResourcesDrawer mode="docked" now={NOW} />);
    await screen.findByRole('heading', { name: /^Personal Codex/ });
    const card = within(cardOf('Personal Codex'));
    expect(card.getByText('Credits available')).toBeInTheDocument();
    expect(card.getAllByText('2,500 credits available').length).toBeGreaterThan(0);
    fireEvent.click(card.getByText('Usage details'));
    expect(card.getByTitle('Provider balance: 2,500 credits.')).toHaveTextContent('Native balance 2,500 credit units.');
    expect(creditAccount.capacity.credits.balance).toBe('2500.0000');
    expect(card.getByText(/Estimated credit value: \$100/)).toBeInTheDocument();
    expect(card.getByText(/not actual purchase price or attributed spend/)).toBeInTheDocument();
    expect(card.getByRole('link', { name: 'Published reference' })).toHaveAttribute('href', 'https://developers.openai.com/community/students');
    expect(card.getByText('limit reached')).toBeInTheDocument();
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it('opens focusable scheduling details without extra reads, actions or changing the active chat', async () => {
    budget = { ...BUDGET, scheduling: { sourceState: 'ready', observedAt: new Date(NOW).toISOString(), accounts: [{
      seatId: 'codex-cmp', observedAt: CHECKED, admission: 'held', headroomPercent: 0,
      reset: { kind: 'unknown', at: RESET, description: null, source: null },
      opportunity: { kind: 'held', reason: 'account policy holds' }, forecast: null,
    }] } };
    setVerseActiveSession('existing-chat');
    const user = userEvent.setup();
    render(<ResourcesDrawer mode="docked" now={NOW} />);
    await screen.findByRole('heading', { name: /^Cash Margin Partners/ });
    const card = within(cardOf('Cash Margin Partners'));
    await waitFor(() => expect(card.getByText('Held back by current account or reserve limits.')).toBeInTheDocument());
    const summary = card.getByText('Usage details');
    summary.focus();
    const reads = calls.length;
    expect(summary).toHaveFocus();
    // Native summary keyboard activation belongs to browser acceptance; jsdom
    // does not implement its Enter default action. Exercise native click here.
    await user.click(summary);
    expect(summary.closest('details')!.open).toBe(true);
    expect(card.getByText('Reset behavior not reported.')).toBeVisible();
    expect(card.queryByText(/Opportunity to use/)).toBeNull();
    expect(getVerseUiState().activeSessionId).toBe('existing-chat');
    expect(calls.length).toBe(reads);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });
  it('keeps tier cards in roster order while leading with shared status wording', async () => {
    render(<ResourcesDrawer mode="docked" now={NOW} />);
    await screen.findByRole('heading', { name: /^Cash Margin Partners/ });
    // Tiers stay truthful; within each tier roster order stays fixed as readings arrive.
    const elite = within(screen.getByRole('region', { name: 'Elite' }));
    const names = elite.getAllByRole('heading', { level: 4 }).map((h) => h.textContent!.replace(/(max|pro|plus|SuperGrok|claude\.ai)$/, ''));
    expect(names.filter((n) => n !== 'Claude cloud estimate')).toEqual(['Personal Codex', 'Claude Max', 'Cash Margin Partners']);
    const fast = within(screen.getByRole('region', { name: 'Fast' }));
    expect(fast.getAllByRole('heading', { level: 4 }).map((h) => h.textContent!.replace(/SuperGrok$/, ''))).toEqual(['Grok']);
    // The same facts row on every card: tier · cost basis · models.
    expect(within(cardOf('Cash Margin Partners')).getByText('Elite')).toBeInTheDocument();
    expect(within(cardOf('Cash Margin Partners')).getByText('subscription')).toBeInTheDocument();
    expect(within(cardOf('Grok')).getByText('Fast')).toBeInTheDocument();

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
    expect(out.getByText('Grok Build · native CLI')).toBeInTheDocument();
    expect(within(cardOf('Cash Margin Partners')).queryByText('Grok Build · native CLI')).not.toBeInTheDocument();
    expect(out.getByText('Signed out')).toBeInTheDocument();
    expect(out.getByText('· reconnect to use it')).toBeInTheDocument();
    expect(out.getByRole('button', { name: 'Reconnect: Grok' })).toBeInTheDocument();
  });

  it('draws each window with the one percent rule and its reset, and the reserve kept for Mason', async () => {
    render(<ResourcesDrawer mode="docked" now={NOW} />);
    await screen.findByRole('heading', { name: /^Claude Max/ });
    await waitFor(() => expect(within(cardOf('Claude Max')).getByText('Reserved for you 40% · balanced mode')).toBeInTheDocument());
    const claude = within(cardOf('Claude Max'));
    fireEvent.click(claude.getByText('Usage details'));
    expect(claude.getByText('92%')).toBeInTheDocument();
    expect(claude.getByText('15%')).toBeInTheDocument();
    expect(claude.getByRole('img', { name: /5-hour window: 15% used/ })).toBeInTheDocument();
    // The binding window carries the reserve in its sentence.
    expect(claude.getAllByRole('img').some((m) => /40% kept for you/.test(m.getAttribute('aria-label') ?? ''))).toBe(true);
    expect(within(cardOf('Personal Codex')).getByText('limit reached')).toBeInTheDocument();
  });

  it('shows cached account usage immediately while independent reads are still pending', async () => {
    await runQuery(verseBootstrapQuery.key, async () => ({ seats: ROSTER, projects: [], sessions: [], dispatchEnabled: true, localRuntime: {} }));
    await runQuery(budgetQuery.key, async () => BUDGET);
    // No new read has finished: an already-known quota must remain useful.
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));
    render(<ResourcesDrawer mode="docked" now={NOW} />);
    expect(within(cardOf('Cash Margin Partners')).getByText('31%')).toBeInTheDocument();
    expect(within(cardOf('Claude Max')).getByText('92%')).toBeInTheDocument();
    expect(screen.queryByText('Reading accounts…')).toBeNull();
    expect(screen.getByText('Updating readings…')).toBeInTheDocument();
  });

  it('refreshes seats, usage and every shared source independently without a status sweep or row reorder', async () => {
    render(<ResourcesDrawer mode="docked" now={NOW} />);
    await screen.findByRole('heading', { name: /^Cash Margin Partners/ });
    const paths = ['/api/verse/seats', '/api/verse/budget', '/api/verse/health', '/api/verse/local-models', '/api/verse/runtime', '/api/verse/cloud', '/api/verse/devin', '/api/verse/budget/readiness'];
    await waitFor(() => expect(paths.filter((path) => path !== '/api/verse/seats').every((path) => calls.some((c) => c.url === path))).toBe(true));
    const counts = new Map(paths.map((path) => [path, calls.filter((c) => c.url === path).length]));
    const cardOrder = () => [...document.querySelectorAll('[data-seat]')].map((card) => card.getAttribute('data-seat'));
    const before = cardOrder();
    roster = [...ROSTER].reverse(); // A refresh must use the returned roster, not status sorting.
    fireEvent.click(screen.getByRole('button', { name: 'Read everything again' }));
    await waitFor(() => expect(paths.every((path) => calls.filter((c) => c.url === path).length > counts.get(path)!)).toBe(true));
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
    await waitFor(() => expect(cardOrder()).toEqual(['codex-cmp', 'claude-a', 'codex-personal', 'grok']));
    expect(cardOrder()).not.toEqual(before);
    // Ordinary status completion on that same roster never moves a card.
    const refreshed = cardOrder();
    fireEvent.click(screen.getByRole('button', { name: 'Read everything again' }));
    await waitFor(() => expect(cardOrder()).toEqual(refreshed));
  });

  it('explains absent provider usage and expands quiet details without fetching and exposes a focusable summary', async () => {
    roster = [nativeSeat(capacity({ windows: [], binding: null, usability: 'unknown' }), { id: 'codex-no-quota', engine: 'codex', label: 'Codex without quota', accountId: 'codex-no-quota' })];
    const user = userEvent.setup();
    render(<ResourcesDrawer mode="docked" now={NOW} />);
    const card = within(await screen.findByRole('heading', { name: /^Codex without quota/ }).then((head) => head.closest('li')!));
    expect(card.getByText('Usage not reported by this resource.')).toBeInTheDocument();
    expect(card.queryByText('0%')).toBeNull();
    const details = card.getByText('Usage details').closest('details')!;
    expect(details.open).toBe(false);
    const count = calls.length;
    card.getByText('Usage details').focus();
    expect(card.getByText('Usage details')).toHaveFocus();
    await user.click(card.getByText('Usage details'));
    expect(details.open).toBe(true);
    expect(card.getByText('Connection status and usage are separate. No percentage has been supplied.')).toBeVisible();
    expect(calls.length).toBe(count);
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

  it('Check again refreshes only the selected usage reading and qualifies unknown usage', async () => {
    const user = userEvent.setup();
    render(<ResourcesDrawer mode="docked" now={NOW} />);
    await user.click(await screen.findByRole('button', { name: 'Check again: Personal Codex' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/api/verse/seats/refresh')).toBe(true));
    expect(await screen.findByText(/Check completed; no current usage reading was reported/)).toBeInTheDocument();
    expect(calls.find(c => c.url === '/api/verse/seats/refresh')).toMatchObject({ body: { seatId: 'codex-personal' }, token: TOKEN });
    expect(calls.some(c => c.method === 'POST' && c.url === '/api/verse/health/refresh')).toBe(false);
  });

  it('does not announce a late selected check after auth loss and re-hold', async () => {
    const ordinary = globalThis.fetch;
    let release!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/verse/seats/refresh') return new Promise<Response>(resolve => { release = resolve; });
      return ordinary(input, init);
    }));
    const view = render(<ResourcesDrawer mode="docked" now={NOW} />);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Check again: Personal Codex' }));
    await waitFor(() => expect(release).toBeTypeOf('function'));
    await act(async () => { clearMutationToken(); setMutationToken(TOKEN); release(json({ seatId: 'codex-personal',
      state: 'completed', reading: 'unknown', reason: 'usage-not-reported', observedAt: null, expiresAt: null, nextCheckAt: null, joined: false })); });
    expect(screen.queryByText(/Check completed; no current usage reading/)).toBeNull();
    expect(screen.queryByText(/Confirmed Personal Codex/)).toBeNull();
    view.unmount();
  });

  it('settles an unmounted selected request without starting a fresh seats read', async () => {
    const ordinary = globalThis.fetch;
    let release!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/verse/seats/refresh') return new Promise<Response>(resolve => { release = resolve; });
      return ordinary(input, init);
    }));
    const view = render(<ResourcesDrawer mode="docked" now={NOW} />);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Check again: Personal Codex' }));
    await waitFor(() => expect(release).toBeTypeOf('function'));
    view.unmount(); const reads = calls.filter(c => c.url === '/api/verse/seats').length;
    await act(async () => { release(json({ seatId: 'codex-personal', state: 'completed', reading: 'unknown',
      reason: 'usage-not-reported', observedAt: null, expiresAt: null, nextCheckAt: null, joined: false })); });
    expect(calls.filter(c => c.url === '/api/verse/seats')).toHaveLength(reads);
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
  it('does not pass its earlier timer clock to freshly completed local metadata', async () => {
    let clock = NOW;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const view = render(<ResourcesDrawer mode="docked" />);
    await screen.findByRole('heading', { name: /^Local models/ });
    clock += 2000;
    await act(async () => { await runQuery(verseLocalModelsQuery.key, async () => ({ available: true as const,
      raw: { ...LOCAL_MODELS, sampledAt: new Date(clock).toISOString(),
        machine: { ...LOCAL_MODELS.machine, cpu: { usedPercent: 15, intervalMs: 30_000 } } } })); });
    expect(await screen.findByText('Host CPU · 15% across all cores · 30 s interval · just measured')).toBeInTheDocument();
    clock += 120_000;
    view.rerender(<ResourcesDrawer mode="docked" />);
    expect(await screen.findByText(/Host CPU · 15% across all cores · 30 s interval · 2 min ago/)).toBeInTheDocument();
  });
  it('shows the runtime, the context each model runs at, and starts a supervised runtime', async () => {
    const user = userEvent.setup();
    render(<ResourcesDrawer mode="docked" now={NOW} />);
    const local = within(await screen.findByRole('region', { name: 'Free · local' }));
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
    const card = within(cardOf('Claude cloud estimate'));
    expect(await card.findByText('Cloud lane not available yet')).toBeInTheDocument();
    expect(card.queryByText(/\$/)).toBeNull();
  });

  it('shows the estimated remaining of the total, running sessions and the real-balance link', async () => {
    cloud = CLOUD;
    render(<ResourcesDrawer mode="docked" now={NOW} />);
    const card = within(cardOf('Claude cloud estimate'));
    expect(await card.findByText('$210 of $250 left')).toBeInTheDocument();
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
    const card = within(cardOf('Claude cloud estimate'));
    expect(await card.findByText('Not set up')).toBeInTheDocument();
    expect(card.getByText('· ~$250 credits')).toBeInTheDocument();
    expect(card.getByText('estimate')).toBeInTheDocument();
    expect(card.getByText("The Claude seat isn't set up on this Mac.")).toBeInTheDocument();
    expect(cardOf('Claude cloud estimate').textContent).not.toMatch(/of \$250 left/);
    expect(card.getByTitle('Cloud: not set up · ~$250 credits')).toBeInTheDocument();
    expect(card.getByRole('link', { name: /Real balance on claude\.ai/ })).toBeInTheDocument();
  });
});

describe('ResourcesDrawer — readiness for chat and the fleet (3.14)', () => {
  it('an older server (404) shows no readiness lines — never a false "not ready"', async () => {
    render(<ResourcesDrawer mode="docked" now={NOW} />);
    await screen.findByRole('heading', { name: /^Cash Margin Partners/ });
    expect(screen.queryByRole('group', { name: /readiness/ })).toBeNull();
    expect(await screen.findByText('Readiness isn’t available on this version.')).toBeInTheDocument();
    expect(getQuerySnapshot(resourceReadinessQuery.key).status).toBe('success');
  });

  it('explains the pending initial read and shows readiness only when that read succeeds', async () => {
    let complete!: (response: Response) => void;
    readinessResponse = () => new Promise<Response>((resolve) => { complete = resolve; });
    render(<ResourcesDrawer mode="docked" now={NOW} />);
    await screen.findByRole('heading', { name: /^Cash Margin Partners/ });
    expect(screen.getByText('Checking Chat and Fleet readiness…')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /readiness/ })).toBeNull();
    await act(async () => { complete(json(READINESS)); });
    expect(await screen.findByRole('group', { name: 'Claude Max: readiness' })).toBeInTheDocument();
    expect(screen.queryByText('Checking Chat and Fleet readiness…')).toBeNull();
  });

  it.each([
    ['service failure', () => Promise.resolve(json({ error: 'unavailable' }, 503))],
    ['network failure', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['invalid body', () => Promise.resolve(json({ v: 1, resources: [], autonomy: {} }))],
    ['invalid verdict', () => Promise.resolve(json({ ...READINESS, resources: [{ ...READINESS.resources[0], chat: { ready: true } }] }))],
    ['coded refusal', () => Promise.resolve(json({ error: 'unavailable', code: 'READINESS_UNAVAILABLE' }, 404))],
  ] as const)('explains %s without treating it as unsupported or ready', async (_name, response) => {
    readinessResponse = response;
    render(<ResourcesDrawer mode="docked" now={NOW} />);
    expect(await screen.findByText('Readiness unavailable · try Read everything again.')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /readiness/ })).toBeNull();
    expect(screen.queryByText('Readiness isn’t available on this version.')).toBeNull();
    expect(getQuerySnapshot(resourceReadinessQuery.key).status).toBe('error');
    expect(within(cardOf('Claude Max')).getByText('92%')).toBeInTheDocument();
  });

  it('retains but never reports a failed last result as Ready, including during retry, then recovers', async () => {
    readiness = READINESS;
    render(<ResourcesDrawer mode="docked" now={NOW} />);
    await screen.findByRole('group', { name: 'Claude Max: readiness' });
    const previous = getQuerySnapshot(resourceReadinessQuery.key).data;
    readinessResponse = async () => json({ error: 'unavailable' }, 503);
    fireEvent.click(screen.getByRole('button', { name: 'Read everything again' }));
    expect(await screen.findByText('Readiness unavailable · last result is unverified.')).toBeInTheDocument();
    expect(getQuerySnapshot(resourceReadinessQuery.key).data).toBe(previous);
    expect(screen.queryByRole('group', { name: /readiness/ })).toBeNull();
    let complete!: (response: Response) => void;
    readinessResponse = () => new Promise<Response>((resolve) => { complete = resolve; });
    fireEvent.click(screen.getByRole('button', { name: 'Read everything again' }));
    await waitFor(() => expect(getQuerySnapshot(resourceReadinessQuery.key).status).toBe('refreshing'));
    expect(screen.getByText('Readiness unavailable · last result is unverified.')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /readiness/ })).toBeNull();
    await act(async () => { complete(json(READINESS)); });
    expect(await screen.findByRole('group', { name: 'Claude Max: readiness' })).toBeInTheDocument();
    expect(screen.queryByText('Readiness unavailable · last result is unverified.')).toBeNull();
    expect(getQuerySnapshot(resourceReadinessQuery.key).error).toBeUndefined();
  });

  it('keeps session expiry as an authenticated error and never admits retained readiness', async () => {
    readiness = READINESS;
    render(<ResourcesDrawer mode="docked" now={NOW} />);
    await screen.findByRole('group', { name: 'Claude Max: readiness' });
    readinessResponse = async () => json({ error: 'expired' }, 401);
    fireEvent.click(screen.getByRole('button', { name: 'Read everything again' }));
    expect(await screen.findByText('Readiness unavailable · sign in again.')).toBeInTheDocument();
    const error = getQuerySnapshot(resourceReadinessQuery.key).error;
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    expect(screen.queryByRole('group', { name: /readiness/ })).toBeNull();
  });

  it('propagates cancellation instead of treating an aborted read as an unsupported route', async () => {
    const aborted = new DOMException('Cancelled', 'AbortError');
    readinessResponse = () => Promise.reject(aborted);
    await expect(resourceReadinessQuery.fetch()).rejects.toBe(aborted);
  });

  it('every account card answers Chat and Fleet, with the reserve kept for Mason in words', async () => {
    readiness = READINESS;
    render(<ResourcesDrawer mode="docked" now={NOW} />);
    const claude = within(await screen.findByRole('group', { name: 'Claude Max: readiness' }));
    expect(claude.getByText('Chat')).toBeInTheDocument();
    expect(claude.getByText('Fleet')).toBeInTheDocument();
    expect(claude.getByText('Ready · reserve 40% kept for you')).toBeInTheDocument();
    expect(claude.getByText('35% of the weekly window is left for the fleet. Roles: judges, leads.')).toBeInTheDocument();

    const cmp = within(screen.getByRole('group', { name: 'Cash Margin Partners: readiness' }));
    expect(cmp.getByText('Not in this stage')).toBeInTheDocument();
    expect(cmp.getByText(/the Codex lane opens at stage 5 \(3a\)/)).toBeInTheDocument();
    // Reconnect / Check again stay the card's own buttons — readiness never repeats them.
    expect(cmp.queryByRole('button')).toBeNull();
  });

  it('local is one resource: Chat / Fleet plus a line per runtime, including a wedged llama-server', async () => {
    readiness = READINESS;
    localModels = {
      ...LOCAL_MODELS,
      ollama: { ...LOCAL_MODELS.ollama, baseUrl: 'http://127.0.0.1:11434' },
      lmStudio: { reachable: true, baseUrl: 'http://127.0.0.1:1234', models: [{ id: 'qwen/qwen3-coder-30b', state: 'available' }] },
      llamaServer: { reachable: false, baseUrl: 'http://127.0.0.1:8080', status: 'down', models: [], modelCount: null, slots: null, reason: 'llama-server-timeout' },
    };
    render(<ResourcesDrawer mode="docked" now={NOW} />);
    const local = within(await screen.findByRole('region', { name: 'Free · local' }));
    expect(await local.findByRole('group', { name: 'Local models: readiness' })).toBeInTheDocument();
    const runtimes = within(await local.findByRole('list', { name: 'Local runtimes' }));
    expect(runtimes.getByText('Ollama')).toBeInTheDocument();
    expect(runtimes.getByText('Answering · 2 installed · 1 loaded')).toBeInTheDocument();
    expect(runtimes.getByText('LM Studio')).toBeInTheDocument();
    expect(runtimes.getByText('Answering · 1 installed · none loaded')).toBeInTheDocument();
    expect(runtimes.getByText('llama-server')).toBeInTheDocument();
    expect(runtimes.getByText('Not answering · listening on :8080 but not answering — restart it')).toBeInTheDocument();
  });

  it('the cloud card shows the one command that sets the Claude seat up, copyable', async () => {
    readiness = READINESS;
    cloud = { ...CLOUD, seat: { id: 'claude-a', ready: false, reason: "The Claude seat isn't set up on this Mac." } };
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<ResourcesDrawer mode="docked" now={NOW} />);
    const group = within(await screen.findByRole('group', { name: 'Claude cloud: readiness' }));
    expect(group.getByText('Set up the Claude seat — run in Terminal')).toBeInTheDocument();
    const code = group.getByText(/^ashlr resources profile prepare --provider claude/);
    expect(code.tagName).toBe('CODE');
    await userEvent.click(group.getByRole('button', { name: 'Copy command: Set up the Claude seat' }));
    expect(writeText).toHaveBeenCalledWith(SETUP_COMMAND);
    expect(await group.findByText('Copied')).toBeInTheDocument();
  });

  it('an account with only an expired reading says when, and why — never a current claim', async () => {
    readiness = { ...READINESS, resources: READINESS.resources.map((r) => (r.id === 'personal-last' ? { ...r, id: 'codex-personal' } : r)) };
    render(<ResourcesDrawer mode="docked" now={NOW} />);
    const personal = within(await screen.findByRole('group', { name: 'Personal Codex: readiness' }));
    expect(personal.getByText(/^Last reading .+ · Polling is paused/)).toBeInTheDocument();
    expect(personal.getByText('No reading')).toBeInTheDocument();
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

  it('opens proactive profiles from Resources without treating them as executable model seats', async () => {
    const user = userEvent.setup();
    openResources();
    render(<ResourcesDrawer mode="overlay" now={NOW} />);
    const reveal = vi.fn();
    window.addEventListener(VERSE_ANCHOR_EVENT, reveal, { once: true });
    await user.click(screen.getByRole('button', { name: 'Proactive agents' }));
    expect(getResourcesUi().open).toBe(false);
    expect(getVerseUiState().section).toBe('agents');
    expect((reveal.mock.calls[0]![0] as CustomEvent<VerseAnchorRequest>).detail).toEqual({ section: 'agents', anchor: 'proactive-agents' });
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

// ---------------------------------------------------------------------------
// 3.15 — equal partners: Devin is an Elite card like Claude and Codex
// ---------------------------------------------------------------------------

const DEVIN_HEALTH = { state: 'ready' as const, summary: null, windows: [], observedAt: CHECKED };
const DEVIN_CLOUD_SEAT = {
  id: 'devin', engine: 'devin', label: 'Devin (cloud)', accountId: 'devin', contextWindow: null, health: DEVIN_HEALTH, costBasis: 'credits',
  models: [{ id: 'devin', label: 'Devin', contextWindow: null, windowSource: 'fallback' }],
};
const DEVIN_CLI_SEAT = {
  id: 'devin-cli', engine: 'devin', label: 'Devin (CLI)', accountId: 'devin-cli', contextWindow: null, health: DEVIN_HEALTH,
  models: [
    { id: 'devin', label: 'Devin default', contextWindow: null, windowSource: 'fallback' },
    { id: 'swe', label: 'SWE (latest)', contextWindow: null, windowSource: 'fallback' },
  ],
};
const DEVIN_OVERVIEW = {
  generatedAt: CHECKED,
  status: {
    enabled: true, connected: true, state: 'ready', reason: 'Connected.', orgId: 'org-x', principal: 'service_user', principalName: 'Ashlr Verse', keyStore: 'keychain',
    chatLine: 'Chat: ready', fleetLine: 'Fleet: Off', fleetReady: false,
    chat: { ready: true, tone: 'ok', word: 'Ready', detail: '', fix: null },
    fleet: { ready: false, tone: 'off', word: 'Off', detail: 'The fleet may not launch Devin sessions.', fix: { kind: 'command', label: 'Let the fleet use Devin', command: 'ashlr devin fleet on' }, roles: [], reservePercent: null },
  },
  budget: {
    acuBudgetTotal: 50, acuUsed: 12, acuRemaining: 38, acuToday: 12, acuInFlight: 0, estimatedUsdUsed: 27, sessionsToday: 2, running: 0, paused: false,
    canLaunch: { ok: true, reason: null }, canFleetLaunch: { ok: true, reason: null }, estimateNote: 'Estimate.', usageUrl: 'https://app.devin.ai/settings/usage',
    budget: { v: 1, acuBudgetTotal: 50, acuSpentAdjustment: 0, usdPerAcu: 2.25, maxAcuPerSession: 10, maxAcuPerDay: 30, reserveAcu: 10, pauseAtFraction: 0.9, maxConcurrent: 2, maxSessionsPerDay: 10, updatedAt: CHECKED },
  },
  tasks: [],
};

describe('ResourcesDrawer — equal partners (3.15)', () => {
  it('Devin is ONE Elite card beside Claude and Codex, with the same facts row — never two generic account cards', async () => {
    roster = [...ROSTER, DEVIN_CLOUD_SEAT, DEVIN_CLI_SEAT];
    devin = DEVIN_OVERVIEW;
    render(<ResourcesDrawer mode="docked" now={NOW} />);
    const elite = within(await screen.findByRole('region', { name: 'Elite' }));
    const heading = await elite.findByRole('heading', { name: /^Devin/ });
    const card = within(heading.closest('li')!);
    expect(card.getByText('Elite')).toBeInTheDocument();
    // Cloud spends ACU credits; the CLI rides the Devin plan.
    expect(card.getByText('credits + subscription')).toBeInTheDocument();
    expect(card.getByText('10 ACUs kept for you')).toBeInTheDocument();
    expect(card.getByText('local limits')).toBeInTheDocument();
    expect(heading.closest('li')!.querySelector('svg[data-provider="devin"]')).toHaveAttribute('viewBox', '0 0 425 425');
    expect(card.getByTitle('Devin, Devin default, SWE (latest)')).toBeInTheDocument();
    // The Devin chat seats are not ALSO drawn as generic account cards.
    expect(screen.queryByRole('heading', { name: /^Devin \(cloud\)/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: /^Devin \(CLI\)/ })).toBeNull();
    // Every elite card carries the same facts row.
    for (const name of ['Personal Codex', 'Claude Max', 'Cash Margin Partners']) {
      expect(within(cardOf(name)).getByText('Elite')).toBeInTheDocument();
    }
  });

  it('the rail labels tracked ACU budget and estimated cloud credits, with the real Devin mark', async () => {
    devin = DEVIN_OVERVIEW;
    cloud = CLOUD;
    render(<ResourcesBar expanded />);
    const devinButton = await screen.findByRole('button', { name: 'Devin tracked budget: 38 ACUs of 50 ACUs left. Open Resources' });
    expect(within(devinButton).getByText('38 ACUs budget')).toBeInTheDocument();
    expect(devinButton.querySelector('svg[data-provider="devin"]')).toHaveAttribute('viewBox', '0 0 425 425');
    expect(devinButton.textContent).not.toMatch(/^DDevin/);
    expect(await screen.findByText('$210 est.')).toBeInTheDocument();
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('keeps legacy display groups in order without claiming measured quality or role restrictions', async () => {
    render(<ResourcesDrawer mode="docked" now={NOW} />);
    await screen.findByRole('heading', { name: /^Cash Margin Partners/ });
    const titles = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(titles).toEqual(['Use allowance before resets', 'Elite', 'Fast', 'Free · local', 'Decision layer']);
    expect(within(screen.getByRole('region', { name: 'Elite' })).getByText(/equal partners/)).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Elite' })).getByText(/does not restrict Leader or Manager roles/)).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Fast' })).getByText(/legacy Fast display group.*does not establish measured speed or price/)).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Free · local' })).getByText(/connected tools can use network services/)).toBeInTheDocument();
  });
});
