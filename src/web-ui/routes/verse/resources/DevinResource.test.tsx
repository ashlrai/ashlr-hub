/**
 * DevinResource.test.tsx — the Devin card in the Resources drawer (3.15):
 * nothing on a server without the lane; "Not set up" with the connect command
 * and Chat n/a; connected with the ACU meter, the paused state and the
 * readiness lines; a waiting session's reply going through the token gate to
 * POST /api/verse/devin/tasks/<id>/message. The page never asks for a key.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { DevinResource } from './DevinResource.js';
import { runInDevinBlock } from '../devin/devin-model.js';

const TOKEN = 'test-token';
let overview: unknown;
let posts: Array<{ url: string; body: unknown; token: string | null }>;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function status(over: Record<string, unknown> = {}) {
  return {
    enabled: true, connected: true, state: 'ready', reason: 'Connected. Devin sessions deliver pull requests through the standing gates.',
    orgId: 'org-x', principal: 'service_user', principalName: 'Ashlr Verse', keyStore: 'keychain',
    chatLine: 'Chat: n/a — Devin works in sessions, not chat turns', fleetLine: 'Fleet: Off', fleetReady: false,
    chat: { ready: false, tone: 'off', word: 'n/a', detail: 'Devin works in sessions, not chat turns. Use Run in Devin from a chat.', fix: null },
    fleet: { ready: false, tone: 'off', word: 'Off', detail: 'The fleet may not launch Devin sessions; you can still run them yourself.', fix: { kind: 'command', label: 'Let the fleet use Devin', command: 'ashlr devin fleet on' }, roles: [], reservePercent: null },
    ...over,
  };
}

function budget(over: Record<string, unknown> = {}) {
  return {
    acuBudgetTotal: 50, acuUsed: 12, acuRemaining: 38, acuToday: 12, acuInFlight: 4, estimatedUsdUsed: 27, sessionsToday: 2, running: 1, paused: false,
    canLaunch: { ok: true, reason: null }, canFleetLaunch: { ok: true, reason: null },
    estimateNote: 'ACUs come from Devin\'s own session readings; dollars are an estimate at $2.25 per ACU.',
    usageUrl: 'https://app.devin.ai/settings/usage',
    budget: { v: 1, acuBudgetTotal: 50, acuSpentAdjustment: 0, usdPerAcu: 2.25, maxAcuPerSession: 10, maxAcuPerDay: 30, reserveAcu: 10, pauseAtFraction: 0.9, maxConcurrent: 2, maxSessionsPerDay: 10, updatedAt: '2026-09-27T00:00:00.000Z' },
    ...over,
  };
}

function blockedTask() {
  return {
    v: 1, id: 'dv_20260927T0400_aaaaaa', repo: 'ashlrai/x', baseBranch: 'main', branch: 'ashlr-devin/dv_20260927T0400_aaaaaa', title: 'Add a helper', prompt: 'p',
    origin: 'chat', requestedBy: 'mason', sessionId: 'devin-1', sessionUrl: 'https://app.devin.ai/sessions/devin-1', state: 'blocked',
    stateReason: 'Devin is waiting for your reply.', failure: null, createdAt: '2026-09-27T00:00:00.000Z', launchedAt: null, updatedAt: '2026-09-27T00:00:00.000Z',
    session: null, maxAcu: 10, devinMode: 'normal', pr: null, headSha: null, report: null, backlogItemId: null,
  };
}

beforeEach(() => {
  evictAll();
  setMutationToken(TOKEN);
  posts = [];
  overview = { generatedAt: '2026-09-27T00:00:00.000Z', status: status(), budget: budget(), tasks: [] };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if ((init?.method ?? 'GET').toUpperCase() === 'POST') {
      posts.push({ url, body: JSON.parse(String(init?.body ?? '{}')), token: new Headers(init?.headers).get('x-ashlr-token') });
      return json({ ok: true, task: blockedTask() });
    }
    if (url === '/api/verse/devin') return overview === 404 ? json({ error: 'not found' }, 404) : json(overview);
    return json({ error: 'not found' }, 404);
  }));
});

afterEach(() => {
  clearMutationToken();
  vi.unstubAllGlobals();
});

const mount = () => render(<ul><DevinResource /></ul>);

describe('DevinResource', () => {
  it('renders nothing on a server without the Devin lane', async () => {
    overview = 404;
    const { container } = mount();
    await waitFor(() => expect(container.querySelector('[data-devin="loading"]')).toBeNull());
    expect(container.querySelector('[data-resource="devin"]')).toBeNull();
  });

  it('not set up: says so, shows Chat n/a and the connect command — and never a key field', async () => {
    overview = {
      generatedAt: 'x', tasks: [], budget: budget(),
      status: status({ enabled: false, connected: false, state: 'disabled', reason: 'Not set up. Run `ashlr devin connect` to add your Devin API key.', fleet: { ready: false, tone: 'off', word: 'Off', detail: 'Connect Devin first.', fix: { kind: 'command', label: 'Connect Devin', command: 'ashlr devin connect' }, roles: [], reservePercent: null } }),
    };
    mount();
    const card = await screen.findByText('Not set up');
    const li = card.closest('li')!;
    expect(within(li).getByRole('group', { name: 'Devin: readiness' })).toBeTruthy();
    expect(within(li).getByText('n/a')).toBeTruthy();
    expect(within(li).getByText('ashlr devin connect')).toBeTruthy();
    expect(within(li).queryByRole('meter')).toBeNull();
    expect(li.querySelector('input[type="password"]')).toBeNull();
  });

  it('the "% left" readout follows the one percent rule: 0.36% left is "<1% left", never "0% left"', async () => {
    overview = { generatedAt: 'x', tasks: [], status: status(), budget: budget({ acuBudgetTotal: 1000, acuRemaining: 3.6, acuInFlight: 0 }) };
    mount();
    expect(await screen.findByText('<1% left')).toBeTruthy();
    expect(screen.queryByText('0% left')).toBeNull();
  });

  it('connected: ACUs left of the budget with an estimate note and the usage link', async () => {
    mount();
    expect(await screen.findByText('34 ACUs of 50 ACUs left')).toBeTruthy();
    expect(screen.getByRole('img', { name: /Devin ACUs: 12 ACUs accounted for of 50 ACUs, 34 ACUs left/ })).toBeTruthy();
    expect(screen.getByText(/Recorded cost coverage is unavailable/)).toBeTruthy();
    expect(screen.getByText(/1 running · 2 today/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Real usage on app\.devin\.ai/ }).getAttribute('href')).toBe('https://app.devin.ai/settings/usage');
    expect(screen.getByText('Connected')).toBeTruthy();
  });

  it('separates reported usage from uncertain exposure and excludes held spend from the cost estimate', async () => {
    overview = { generatedAt: 'x', status: status(), tasks: [], budget: budget({
      acuUsed: 10, acuRemaining: 40, acuInFlight: 8, reportedAcuUsed: 2,
      unconfirmedAcuExposure: 18, estimatedUsdUsed: 4.5,
    }) };
    mount();
    expect(await screen.findByText('30 ACUs of 50 ACUs available')).toBeTruthy();
    expect(screen.getByRole('img', { name: /2 ACUs reported usage plus adjustment, 18 ACUs held exposure, 30 ACUs available/ })).toBeTruthy();
    expect(screen.getByText(/2 ACUs reported usage \+ adjustment · 18 ACUs held exposure · about \$4.5 for recorded usage/)).toBeTruthy();
    expect(screen.queryByText(/Recorded cost coverage is unavailable/)).toBeNull();
    expect(screen.queryByText(/about \$22.5/)).toBeNull();
  });

  it('rejects malformed additive usage instead of rendering a false balance', async () => {
    overview = { generatedAt: 'x', status: status(), tasks: [], budget: budget({ reportedAcuUsed: -1, unconfirmedAcuExposure: 10 }) };
    mount();
    expect(await screen.findByText('Unrecognized response — update Ashlr.')).toBeTruthy();
    expect(screen.queryByText(/ACUs.*available/)).toBeNull();
  });

  it('the Devin CLI: says its usage is not reported (not counted) instead of implying it is — even with no API key (3.15)', async () => {
    overview = { generatedAt: 'x', status: status(), budget: budget(), tasks: [], cli: { state: 'ready', usage: 'not-reported' } };
    const { unmount } = mount();
    const line = await screen.findByText(/usage not reported by the CLI/);
    expect(line.closest('[data-devin-cli]')!.getAttribute('data-devin-cli')).toBe('ready');
    unmount();
    evictAll();

    overview = {
      generatedAt: 'x', tasks: [], budget: budget(), cli: { state: 'logged-out', usage: 'not-reported' },
      status: status({ enabled: false, connected: false, state: 'disabled', reason: 'Not set up.' }),
    };
    mount();
    const loggedOut = await screen.findByText(/usage not reported by the CLI/);
    expect(loggedOut.textContent).toMatch(/logged out; run devin auth login/);
    expect(screen.queryByRole('meter')).toBeNull();
  });

  it('the Devin CLI\'s models: SWE-2 (free) + the paid families, and the default (3.15)', async () => {
    overview = {
      generatedAt: 'x', status: status(), budget: budget(), tasks: [], cli: { state: 'ready', usage: 'not-reported' },
      models: { source: 'cli', fetchedAt: '2026-09-27T12:00:00.000Z', freeFamilies: ['SWE-2'], paidFamilyCount: 51, defaultModel: { id: 'swe-2-high', label: 'SWE-2 High', free: true, price: 'Free' } },
    };
    const { unmount } = mount();
    const line = await screen.findByText('Models: SWE-2 (free) + 51 paid families · Default: SWE-2 High (Free)');
    expect(line.getAttribute('data-devin-models')).toBe('cli');
    unmount();
    evictAll();

    // A paid default names its price; a malformed summary shows nothing.
    overview = {
      generatedAt: 'x', status: status(), budget: budget(), tasks: [], cli: { state: 'ready', usage: 'not-reported' },
      models: { source: 'cache', fetchedAt: null, freeFamilies: ['SWE-2'], paidFamilyCount: 1, defaultModel: { id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 High', free: false, price: '$4 in · $20 out per 1M' } },
    };
    const again = mount();
    expect(await screen.findByText('Models: SWE-2 (free) + 1 paid family · Default: Claude Opus 5.5 High ($4 in · $20 out per 1M)')).toBeTruthy();
    again.unmount();
    evictAll();

    overview = { generatedAt: 'x', status: status(), budget: budget(), tasks: [], cli: { state: 'ready', usage: 'not-reported' }, models: { freeFamilies: 'SWE-2' } };
    mount();
    await screen.findByText(/usage not reported by the CLI/);
    expect(screen.queryByText(/^Models:/)).toBeNull();
  });

  it('no Devin CLI installed (or an older server): no CLI line', async () => {
    overview = { generatedAt: 'x', status: status(), budget: budget(), tasks: [], cli: { state: 'missing', usage: 'not-reported' } };
    mount();
    await screen.findByText('34 ACUs of 50 ACUs left');
    expect(screen.queryByText(/usage not reported by the CLI/)).toBeNull();
  });

  it('paused: the pill and the budget\'s own reason', async () => {
    overview = { generatedAt: 'x', status: status(), tasks: [], budget: budget({ paused: true, canLaunch: { ok: false, reason: 'Paused: 45 ACUs of 50 ACUs used.' } }) };
    mount();
    expect(await screen.findByText('paused')).toBeTruthy();
    expect(screen.getByText('Paused: 45 ACUs of 50 ACUs used.')).toBeTruthy();
  });

  it('a waiting session gets a reply box that posts through the mutation token', async () => {
    overview = { generatedAt: 'x', status: status(), budget: budget(), tasks: [blockedTask()] };
    mount();
    const box = await screen.findByRole('textbox', { name: 'Reply to Devin: Add a helper' });
    await userEvent.type(box, 'Use the existing helper.');
    await userEvent.click(screen.getByRole('button', { name: /Send/ }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ url: '/api/verse/devin/tasks/dv_20260927T0400_aaaaaa/message', body: { message: 'Use the existing helper.' }, token: TOKEN });
    expect(await screen.findByText(/Sent\. Devin picks it up/)).toBeTruthy();
  });
});

describe('DevinResource evidence (3.15)', () => {
  it('a waiting session opens its Evidence sheet, read from the Devin timeline route only when asked', async () => {
    overview = { generatedAt: 'x', status: status(), budget: budget(), tasks: [blockedTask()] };
    mount();
    const open = await screen.findByRole('button', { name: 'Evidence: Add a helper' });
    const timelineReads = () => (vi.mocked(fetch).mock.calls as Array<[RequestInfo | URL]>).map(([u]) => String(u)).filter((u) => u.endsWith('/timeline'));
    expect(timelineReads()).toEqual([]);
    await userEvent.click(open);
    expect(await screen.findByRole('dialog', { name: 'Evidence' })).toBeTruthy();
    await waitFor(() => expect(timelineReads()).toEqual(['/api/verse/devin/tasks/dv_20260927T0400_aaaaaa/timeline']));
  });
});

describe('runInDevinBlock', () => {
  const base = { overview: null, overviewReason: null, repo: 'ashlrai/x', rootsLoading: false, prompt: 'Do it' };
  const ov = (s: Record<string, unknown>, b: Record<string, unknown> = {}) => ({ generatedAt: 'x', status: status(s), budget: budget(b), tasks: [] }) as never;
  it('names the one reason it cannot run, in order', () => {
    expect(runInDevinBlock({ ...base, overviewReason: 'The Devin lane is not in this build yet.' })).toBe('The Devin lane is not in this build yet.');
    expect(runInDevinBlock({ ...base, overview: ov({ connected: false }) })).toMatch(/not connected/);
    expect(runInDevinBlock({ ...base, overview: ov({ enabled: false }) })).toMatch(/turned off/);
    expect(runInDevinBlock({ ...base, overview: ov({}), repo: null })).toMatch(/no GitHub origin/);
    expect(runInDevinBlock({ ...base, overview: ov({}, { canLaunch: { ok: false, reason: 'Over the daily cap.' } }) })).toBe('Over the daily cap.');
    expect(runInDevinBlock({ ...base, overview: ov({}), prompt: ' ' })).toMatch(/Type the task/);
    expect(runInDevinBlock({ ...base, overview: ov({}) })).toBeNull();
  });
});
