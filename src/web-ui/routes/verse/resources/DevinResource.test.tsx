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
import { resetGuard, isGuardOpen } from '../shell/guarded-action.js';
import { runInDevinBlock, devinConsumptionEvidence, devinSelfIdentityEvidence } from '../devin/devin-model.js';

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

function consumption(over: Record<string, unknown> = {}) {
  const now = Date.now();
  return { source: 'devin-v3-organization-daily', scope: 'organization', period: 'all-available-reporting-dates',
    dateUnit: 'provider-unspecified', dayBoundaryUtc: '08:00', state: 'ready',
    fetchedAt: new Date(now - 1000).toISOString(), checkedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 300_000).toISOString(), retryAt: null, stale: false, error: null,
    report: { totalAcus: 3.125, days: [{ date: 123, acus: 3.125, products: { devin: 3.125, cascade: null, terminal: 0, automation: null, review: null } }] }, ...over };
}

function identity(over: Record<string, unknown> = {}) {
  return { source: 'devin-v3-self', observedAt: '2026-01-01T00:00:00.000Z', principal: 'service_user',
    hasServiceUserId: true, hasUserId: false, hasApiKeyId: false, hasOrgId: true, hasDevinSessionsOrgId: false, ...over };
}

beforeEach(() => {
  evictAll();
  resetGuard();
  setMutationToken(TOKEN);
  posts = [];
  overview = { generatedAt: '2026-09-27T00:00:00.000Z', status: status(), budget: budget(), tasks: [] };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if ((init?.method ?? 'GET').toUpperCase() === 'POST') {
      posts.push({ url, body: JSON.parse(String(init?.body ?? '{}')), token: new Headers(init?.headers).get('x-ashlr-token') });
      if (url === '/api/verse/devin/consumption/refresh') {
        overview = { ...(overview as Record<string, unknown>), consumption: consumption() };
        return json({ consumption: consumption() });
      }
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

  it('connected: ACUs left of the budget with an estimate note and the usage link', async () => {
    mount();
    expect(await screen.findByText('Local safety budget · 34 ACUs of 50 ACUs left')).toBeTruthy();
    expect(screen.getByRole('img', { name: /Devin ACUs: 12 ACUs accounted for of 50 ACUs, 34 ACUs left/ })).toBeTruthy();
    expect(screen.getByText(/Recorded cost coverage is unavailable/)).toBeTruthy();
    expect(screen.getByText(/1 running · 2 new sessions today/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Real usage on app\.devin\.ai/ }).getAttribute('href')).toBe('https://app.devin.ai/settings/usage');
    expect(screen.getByText('Connected')).toBeTruthy();
  });

  it('keeps old-server account observations unknown without changing connected status or making extra queries', async () => {
    mount();
    const section = await screen.findByRole('region', { name: 'Devin cached account observation' });
    expect(within(section).getByText('Cloud account: not reported')).toBeInTheDocument();
    const funding = screen.getByRole('region', { name: 'Devin subscription and purchased credits' });
    expect(within(funding).getByText('Weekly subscription allowance')).toBeInTheDocument();
    expect(within(funding).getByText('On-demand credits')).toBeInTheDocument();
    expect(within(funding).getAllByText('not reported')).toHaveLength(2);
    expect(funding.textContent).not.toMatch(/0%|\$0|ACUs|resets in/);
    expect(within(funding).queryByRole('img')).toBeNull();
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toEqual(['/api/verse/devin']);
    expect(posts).toHaveLength(0);
  });

  it.each([
    ['service_user', identity(), 'Service account'],
    ['pat_user', identity({ principal: 'pat_user', hasServiceUserId: false, hasUserId: true, hasApiKeyId: true, hasOrgId: false, hasDevinSessionsOrgId: true }), 'Personal access token'],
  ])('shows a cached %s observation separately from org consumption and tracked budget', async (principal, summary, label) => {
    overview = { ...(overview as Record<string, unknown>), status: status({ principal, selfIdentity: summary }), consumption: consumption() };
    mount();
    const section = await screen.findByRole('region', { name: 'Devin cached account observation' });
    expect(within(section).getByText(new RegExp(`Cloud account: ${label} · captured`))).toBeInTheDocument();
    expect(section.querySelector('time')?.getAttribute('datetime')).toBe('2026-01-01T00:00:00.000Z');
    expect(section.textContent).toContain('Cached Devin API /self observation.');
    expect(screen.getByRole('region', { name: 'Devin subscription and purchased credits' }).textContent).toContain('Subscription-only spending is unverified.');
    expect(section.textContent).not.toMatch(/live|fresh|0%|org-x|Ashlr Verse/);
    expect(screen.getByText('3.1 ACUs consumed')).toBeInTheDocument();
    expect(screen.getByText('local limits')).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toEqual(['/api/verse/devin']);
    expect(posts).toHaveLength(0);
  });

  it.each([
    ['malformed', identity({ hasUserId: 'false' })],
    ['future', identity({ observedAt: new Date(Date.now() + 86_400_000).toISOString() })],
    ['foreign discriminator', identity({ principal: 'pat_user', hasServiceUserId: false, hasUserId: true, hasApiKeyId: true })],
    ['raw private field', identity({ userId: 'private-user-do-not-render' })],
  ])('renders an unknown account for %s optional metadata while preserving ordinary readiness', async (_name, summary) => {
    overview = { ...(overview as Record<string, unknown>), status: status({ selfIdentity: summary }) };
    mount();
    const section = await screen.findByRole('region', { name: 'Devin cached account observation' });
    expect(within(section).getByText('Cloud account: not reported')).toBeInTheDocument();
    expect(section.querySelector('time')).toBeNull();
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.queryByText(/private-user-do-not-render/)).toBeNull();
  });

  it('accepts historical canonical captured times without an artificial age TTL', () => {
    expect(devinSelfIdentityEvidence(identity(), Date.parse('2026-10-05T00:00:00.000Z'))).toEqual(identity());
    expect(devinSelfIdentityEvidence(identity({ hasOrgId: false }))).toEqual(identity({ hasOrgId: false }));
  });

  it.each([
    undefined, null, [], {},
    identity({ source: 'other' }), identity({ principal: 'devin_brain' }),
    identity({ observedAt: 'not-a-time' }), identity({ observedAt: '2026-01-01' }),
    identity({ observedAt: '2026-01-01T00:00:00Z' }), identity({ observedAt: '2026-02-30T00:00:00.000Z' }),
    identity({ observedAt: '2099-01-01T00:00:00.000Z' }),
    identity({ hasServiceUserId: false }), identity({ hasUserId: true }),
    identity({ hasApiKeyId: true }), identity({ hasDevinSessionsOrgId: true }),
    identity({ hasOrgId: 1 }), identity({ principal: 'pat_user' }),
    identity({ hasOrgId: undefined }), identity({ orgId: 'private-org' }),
  ])('refuses malformed optional identity evidence %# without guessing account or funding', summary => {
    expect(devinSelfIdentityEvidence(summary)).toBeNull();
  });

  it('reads organization consumption through the guarded token POST and confirms cached readback', async () => {
    mount();
    const section = await screen.findByRole('region', { name: 'Devin organization consumption' });
    expect(within(section).getByText('Consumption not reported by this server')).toBeTruthy();
    await userEvent.click(within(section).getByRole('button', { name: 'Read consumption' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ url: '/api/verse/devin/consumption/refresh', body: {}, token: TOKEN });
    expect(await within(section).findByText('3.1 ACUs consumed')).toBeTruthy();
    expect(within(section).queryByRole('meter')).toBeNull();
    expect(section.textContent).not.toMatch(/\$|% left|resets (Mon|Tue|Wed|Thu|Fri|Sat|Sun)/);
    await userEvent.click(within(section).getByText('Daily consumption (1 reporting buckets)'));
    expect(await within(section).findByText('Provider date 123 · 3.1 ACUs')).toBeTruthy();
    expect(within(section).getByText(/cascade: not reported/)).toBeTruthy();
    expect(within(section).getByText(/zero defaults when product data is unavailable/)).toBeTruthy();
  });

  it('does not read consumption until the existing mutation-token gate is unlocked', async () => {
    clearMutationToken(); mount();
    const section = await screen.findByRole('region', { name: 'Devin organization consumption' });
    await userEvent.click(within(section).getByRole('button', { name: 'Read consumption' }));
    expect(isGuardOpen()).toBe(true); expect(posts).toHaveLength(0);
  });

  it('labels an empty organization report without claiming measured zero consumption', async () => {
    overview = { ...(overview as Record<string, unknown>), consumption: consumption({ report: { totalAcus: 0, days: [] } }) };
    mount();
    const section = await screen.findByRole('region', { name: 'Devin organization consumption' });
    expect(within(section).getByText('No consumption reported')).toBeInTheDocument();
    expect(within(section).queryByText('0 ACUs consumed')).toBeNull();
    expect(within(section).getByText('Daily consumption (0 reporting buckets)')).toBeInTheDocument();
    expect(within(section).getByText(/Balance, subscription limits and resets are not reported/)).toBeInTheDocument();
  });

  it('rejects unknown or malformed usage and preserves a measured zero independently of capacity', () => {
    expect(devinConsumptionEvidence(undefined)).toBeNull();
    expect(devinConsumptionEvidence(consumption({ report: { totalAcus: -1, days: [] } }))).toBeNull();
    expect(devinConsumptionEvidence(consumption({ report: { totalAcus: '0', days: [] } }))).toBeNull();
    expect(devinConsumptionEvidence(consumption({ fetchedAt: new Date(Date.now() + 60_000).toISOString() }))).toBeNull();
    const empty = devinConsumptionEvidence(consumption({ report: { totalAcus: 0, days: [] } }));
    expect(empty?.value).toBe('No consumption reported');
    expect(empty?.report).toEqual({ totalAcus: 0, days: [] });
    expect(empty?.lines).toContain('0 daily reporting buckets; dates retained as provider values.');
    const measuredZero = consumption({ report: { totalAcus: 0, days: [{ date: 123, acus: 0,
      products: { devin: 0, cascade: 0, terminal: 0, automation: null, review: null } }] } });
    expect(devinConsumptionEvidence(measuredZero)?.value).toBe('0 ACUs consumed');
    expect(devinConsumptionEvidence(consumption({ report: { totalAcus: 3.125, days: [] } }))?.value).toBe('3.1 ACUs consumed');
  });

  it.each([false, true])('retains a positive fractional aggregate without daily buckets (stale: %s)', async stale => {
    overview = { ...(overview as Record<string, unknown>), consumption: consumption({ stale, report: { totalAcus: 0.03125, days: [] } }) };
    mount();
    const section = await screen.findByRole('region', { name: 'Devin organization consumption' });
    expect(within(section).getByText(`0.031 ACUs consumed${stale ? ' · last' : ''}`)).toBeInTheDocument();
    expect(within(section).queryByText('No consumption reported')).toBeNull();
    expect(within(section).getByText('Daily consumption (0 reporting buckets)')).toBeInTheDocument();
    expect(within(section).queryByRole('list')).toBeNull();
    expect(section.textContent).not.toMatch(/\$|% left|resets in/);
    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toEqual(['/api/verse/devin']);
    expect(posts).toHaveLength(0);
  });

  it('retains a permission-qualified last reading without representing current capacity', async () => {
    overview = { ...(overview as Record<string, unknown>), consumption: consumption({ state: 'unavailable', stale: true,
      error: { code: 'forbidden', reason: 'ViewOrgConsumption permission is required. Session access is separate.' } }) };
    mount();
    const section = await screen.findByRole('region', { name: 'Devin organization consumption' });
    expect(within(section).getByText('3.1 ACUs consumed · last')).toBeTruthy();
    expect(within(section).getByText(/Session access is separate/)).toBeTruthy();
    expect(screen.getByText('Connected')).toBeTruthy();
    expect(within(section).queryByRole('img')).toBeNull();
    expect(within(section).getByText(/current consumption unconfirmed/)).toBeTruthy();
  });

  it('makes all daily buckets reachable in explicit pages without rendering the full history initially', async () => {
    const days = Array.from({ length: 25 }, (_, date) => ({ date, acus: 0.125, products: { devin: 0.125, cascade: null, terminal: null, automation: null, review: null } }));
    overview = { ...(overview as Record<string, unknown>), consumption: consumption({ report: { totalAcus: 3.125, days } }) };
    mount();
    const section = await screen.findByRole('region', { name: 'Devin organization consumption' });
    expect(within(section).queryByRole('list', { name: 'Devin daily consumption' })).toBeNull();
    await userEvent.click(within(section).getByText('Daily consumption (25 reporting buckets)'));
    const list = await within(section).findByRole('list', { name: 'Devin daily consumption' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(20);
    await userEvent.click(within(section).getByRole('button', { name: 'Next' }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(5);
    expect(within(section).getByText('Provider date 24 · 0.13 ACUs')).toBeTruthy();
    expect(within(section).getByText('Page 2 of 2')).toBeTruthy();
  });

  it('separates reported usage from uncertain exposure and excludes held spend from the cost estimate', async () => {
    overview = { generatedAt: 'x', status: status(), tasks: [], budget: budget({
      acuUsed: 10, acuRemaining: 40, acuInFlight: 8, reportedAcuUsed: 2,
      unconfirmedAcuExposure: 18, estimatedUsdUsed: 4.5,
    }) };
    mount();
    expect(await screen.findByText('Local safety budget · 30 ACUs of 50 ACUs available')).toBeTruthy();
    expect(screen.getByRole('img', { name: /2 ACUs reported usage plus adjustment, 18 ACUs held exposure, 30 ACUs available/ })).toBeTruthy();
    expect(screen.getByText(/2 ACUs reported usage \+ adjustment · 18 ACUs held exposure · about \$4.5 for recorded usage/)).toBeTruthy();
    expect(screen.queryByText(/Recorded cost coverage is unavailable/)).toBeNull();
    expect(screen.queryByText(/about \$22.5/)).toBeNull();
  });

  it('refuses malformed diagnostic counts rather than claiming no legacy exposure', async () => {
    overview = { generatedAt: 'x', status: status(), tasks: [], budget: budget(),
      taskDiagnostics: { sourceState: 'ready', legacyUnboundCount: -1, legacyUnboundAcu: 0 } };
    mount();
    expect(await screen.findByText('Legacy launch exposure is unknown; task evidence is unavailable.')).toBeTruthy();
    expect(screen.queryByText('No legacy launches need account evidence.')).toBeNull();
    expect(posts).toEqual([]);
  });

  it('explains legacy held exposure without claiming provider quota or spending', async () => {
    overview = { generatedAt: 'x', status: status(), tasks: [], budget: budget({ reportedAcuUsed: 0, unconfirmedAcuExposure: 40,
      acuUsed: 40, acuRemaining: 10, acuInFlight: 0, acuToday: 40, running: 0, sessionsToday: 0,
      estimatedUsdUsed: 0, accountingState: 'ready', paused: false,
      canLaunch: { ok: false, reason: 'Another session could take today past the 30 ACUs daily cap (40 ACUs used or held).' } }),
      taskDiagnostics: { sourceState: 'ready', legacyUnboundCount: 4, legacyUnboundAcu: 40 } };
    mount();
    expect(await screen.findByText('4 old launches need account evidence · 40 ACUs held')).toBeTruthy();
    expect(screen.getByText('Local safety budget · 10 ACUs of 50 ACUs available')).toBeTruthy();
    expect(screen.getByText('Local limits · 30 ACUs/day · 10 ACUs/session')).toBeTruthy();
    expect(screen.getByText('0 running · 0 new sessions today · 40 ACUs counted toward the daily limit')).toBeTruthy();
    expect(screen.getByText('Another session could take today past the 30 ACUs daily cap (40 ACUs used or held).')).toBeTruthy();
    expect(screen.getByRole('img', { name: /0 ACUs reported usage plus adjustment, 40 ACUs held exposure, 10 ACUs available/ })).toBeTruthy();
    expect(screen.getByTitle('Local defaults or limits set here, minus reported usage and unresolved exposure; not your provider credit balance or subscription allowance.')).toBeTruthy();
    expect(screen.queryByText('paused')).toBeNull();
    expect(within(screen.getByRole('region', { name: 'Devin subscription and purchased credits' })).getAllByText('not reported')).toHaveLength(2);
    expect(posts).toEqual([]);
  });

  it('keeps missing or invalid local limits unknown without hiding a measured zero', async () => {
    overview = { generatedAt: 'x', status: status(), tasks: [], budget: budget({
      budget: { maxAcuPerDay: Number.NaN }, reportedAcuUsed: 0, unconfirmedAcuExposure: 0,
    }) };
    mount();
    expect(await screen.findByText('Local session and daily limits not reported.')).toBeTruthy();
    expect(screen.queryByText(/Local limits ·/)).toBeNull();
    expect(screen.getByRole('img', { name: /0 ACUs reported usage plus adjustment, 0 ACUs held exposure/ })).toBeTruthy();
    expect(posts).toEqual([]);
  });

  it.each(['missing', 'unavailable'])('hides partial budget capacity on %s task evidence', async sourceState => {
    overview = { generatedAt: 'x', status: status(), tasks: [], budget: budget({ accountingState: sourceState }),
      taskDiagnostics: { sourceState, legacyUnboundCount: null, legacyUnboundAcu: null } };
    mount();
    expect(await screen.findByText('Local budget capacity is unknown; task evidence is unavailable.')).toBeTruthy();
    expect(screen.getByText('Legacy launch exposure is unknown; task evidence is unavailable.')).toBeTruthy();
    expect(screen.queryByRole('img', { name: /Devin (ACUs|tracked budget)/ })).toBeNull();
    expect(screen.queryByText(/ACUs of 50 ACUs/)).toBeNull();
    expect(posts).toEqual([]);
  });

  it('rejects malformed additive usage instead of rendering a false balance', async () => {
    overview = { generatedAt: 'x', status: status(), tasks: [], budget: budget({ reportedAcuUsed: -1, unconfirmedAcuExposure: 10 }) };
    mount();
    expect(await screen.findByText('Unrecognized response — update Phantom.')).toBeTruthy();
    expect(screen.queryByText(/ACUs.*available/)).toBeNull();
  });

  it('the Devin CLI: distinguishes telemetry not imported by Ashlr from the cloud budget, even with no API key', async () => {
    overview = { generatedAt: 'x', status: status(), budget: budget(), tasks: [], cli: { state: 'ready', usage: 'not-reported' } };
    const { unmount } = mount();
    const line = await screen.findByText(/Phantom has not imported CLI session usage/);
    expect(line.closest('[data-devin-cli]')!.getAttribute('data-devin-cli')).toBe('ready');
    expect(line.textContent).toContain('The tracked ACU budget covers cloud sessions.');
    expect(line.textContent).not.toContain('usage not reported by the CLI');
    unmount();
    evictAll();

    overview = {
      generatedAt: 'x', tasks: [], budget: budget(), cli: { state: 'logged-out', usage: 'not-reported' },
      status: status({ enabled: false, connected: false, state: 'disabled', reason: 'Not set up.' }),
    };
    mount();
    const loggedOut = await screen.findByText(/Phantom has not imported CLI session usage/);
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
    await screen.findByText(/Phantom has not imported CLI session usage/);
    expect(screen.queryByText(/^Models:/)).toBeNull();
  });

  it('no Devin CLI installed (or an older server): no CLI line', async () => {
    overview = { generatedAt: 'x', status: status(), budget: budget(), tasks: [], cli: { state: 'missing', usage: 'not-reported' } };
    mount();
    await screen.findByText('Local safety budget · 34 ACUs of 50 ACUs left');
    expect(screen.queryByText(/Phantom has not imported CLI session usage/)).toBeNull();
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
