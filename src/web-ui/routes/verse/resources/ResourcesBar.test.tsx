/**
 * ResourcesBar — the always-on resource bar (3.11.1): batteries show what is
 * LEFT of each account's binding window, roster order stays fixed, spent ones read
 * as empty red batteries, and the bar's on/off choice persists.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { act, cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { ProviderLogo } from '../../../components/primitives/ProviderLogo.js';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { useCapacityData } from '../usage/CapacityStrip.js';
import { useQuery } from '../../../data/hooks.js';
import { evictAll } from '../../../data/cache.js';
import { DEVIN_POLL_MS, devinQuery } from '../devin/devin-queries.js';
import { SectionVisibilityProvider, usePollWhileVisible } from '../shell/section-visibility.js';
import { buildCapacityRows, type CapacityRow, type CapacityWindowRow } from '../usage/capacity-strip-model.js';
import { capacity, nativeSeat, seatWindow } from '../seat-fixtures.test-support.js';
import { barRows, ResourcesBar } from './ResourcesBar.js';
import { ENGINE_LABEL, seatLabel } from '../verse-model.js';
import { creditPoolsQuery } from './CreditPools.js';
import type { CreditPoolsRead, CreditPoolsReadV2 } from '../../../../core/verse/credit-pools-api-types.js';
import { getResourcesUi, reloadResourcesUiForTest, RESOURCES_STORAGE_KEY, setResourcesBar, openResources, closeResources } from './resources-store.js';
import { reloadResourceOrderForTest, RESOURCE_ORDER_KEY } from './resource-order.js';
import { proactiveProfilesQuery } from '../proactive/proactive-queries.js';
import type { ProactiveProfile } from '../../../../core/proactive/types.js';
import { VERSE_ANCHOR_EVENT, type VerseAnchorRequest } from '../verse-ui-store.js';
import { installFetch, json } from '../context/context-fixtures.test-support.js';

const NOW = Date.parse('2026-09-25T02:00:00Z');

describe('Grok Build display identity', () => {
  it('names the built-in native surface without replacing saved account labels or quota', () => {
    expect(ENGINE_LABEL.grok).toBe('Grok Build');
    expect(seatLabel([], { seatId: 'grok-custom', engine: 'grok' })).toBe('Grok Build');
    const saved = { ...nativeSeat(capacity({}), { id: 'grok-custom', engine: 'grok', label: 'Team research' }) };
    expect(seatLabel([saved], { seatId: saved.id, engine: 'grok' })).toBe('Team research');
    const projected = barRows([row({ seatId: saved.id, label: saved.label })], { healthRead: true, now: NOW });
    expect(projected[0]).toMatchObject({ key: 'grok-custom', engine: 'grok', name: 'Team research', leftPercent: 72 });
    expect(projected[0]!.summary).toContain('Team research · Grok Build');
    expect(projected[0]!.detail).toContain('Grok Build · native CLI; Grok Bot has a separate allowance.');
    expect(projected).toHaveLength(1);
    expect(barRows([row({ label: 'Grok Build' })], { healthRead: true, now: NOW })[0]!.summary).not.toContain('Grok Build · Grok Build');
  });
});

beforeEach(() => { localStorage.removeItem(RESOURCE_ORDER_KEY); reloadResourceOrderForTest(); });
afterEach(() => { localStorage.removeItem(RESOURCE_ORDER_KEY); reloadResourceOrderForTest(); });

describe('saved Grok Bot resource metadata', () => {
  const grokSeat = () => {
    const window = seatWindow({ id: 'grok_unified_weekly', usedPercent: 28, resetsAt: '2026-10-03T12:43:50.367Z' });
    return nativeSeat(capacity({ planType: 'SuperGrok', windows: [window], binding: window,
      usability: 'ready', observedAt: new Date(NOW - 30_000).toISOString() }),
    { id: 'grok', engine: 'grok', label: 'Grok', accountId: 'grok' });
  };
  const profile = (id: string, accountId: string, enabled = true): ProactiveProfile => ({
    id, version: 1, identity: { provider: 'grok-bot', accountId, agentId: id }, displayName: id,
    responsibility: '', avatar: { color: '#6554ff', variant: 'classic' }, computer: { kind: 'unknown', label: '', providerComputerId: null },
    services: [], fundingReference: null, enabled, connection: 'configured', lastRun: null,
    createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(),
    operations: { dispatch: { state: 'unverified', verifiedAt: null, note: 'No qualified connection.' },
      status: { state: 'unsupported', verifiedAt: null, note: '' }, cancel: { state: 'unsupported', verifiedAt: null, note: '' },
      result: { state: 'unsupported', verifiedAt: null, note: '' } },
  });
  let profiles: ProactiveProfile[];
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    localStorage.removeItem(RESOURCES_STORAGE_KEY); reloadResourcesUiForTest();
    profiles = [profile('bot-one', 'saved-account-a'), profile('bot-two', 'saved-account-a', false), profile('bot-three', 'saved-account-b')];
    vi.mocked(useCapacityData).mockReturnValue({ seats: [grokSeat()], health: null, budget: null,
      loading: false, refreshing: false, readFailed: false, rosterUnavailable: false, pendingSeatIds: [] });
    vi.mocked(useQuery).mockImplementation(query => ({ data: query.key === proactiveProfilesQuery.key ? { schemaVersion: 1, profiles } : undefined } as never));
  });
  afterEach(() => { cleanup(); evictAll(); vi.restoreAllMocks(); vi.unstubAllGlobals();
    vi.mocked(useQuery).mockReturnValue({ data: undefined } as never); localStorage.removeItem(RESOURCES_STORAGE_KEY); reloadResourcesUiForTest(); });
  const ids = (container: HTMLElement) => [...container.querySelectorAll('[data-resource-id]')].map(row => row.getAttribute('data-resource-id'));

  it('keeps each declared Bot identity unknown beside the unchanged native Build meter and opens its management surface', () => {
    const native = barRows(buildCapacityRows([grokSeat()], { now: NOW }), { healthRead: false, now: NOW })[0]!;
    const view = render(<ResourcesBar expanded />);
    const build = screen.getByRole('button', { name: `${native.summary}. Open Resources` });
    expect(build).toHaveTextContent('72% left');
    expect(view.container.querySelectorAll('[data-resource-id^="account:"]')).toHaveLength(1);
    expect(view.container.querySelectorAll('[data-resource-id^="proactive:"]')).toHaveLength(3);
    for (const saved of profiles) {
      const entry = view.container.querySelector(`[data-resource-id="proactive:${saved.id}"]`)!;
      expect(entry).toHaveTextContent(saved.enabled ? 'Configured · usage unknown' : 'Preference off · usage unknown');
      expect(entry.querySelector('[data-unknown]')).toBeNull(); // No fabricated quota battery.
      expect(entry.textContent).not.toMatch(/%|Ready|Connected/);
      const button = within(entry as HTMLElement).getByRole('button', { name: /Open Proactive agents/ });
      fireEvent.focus(button);
      const tip = screen.getByRole('tooltip');
      expect(tip).toHaveTextContent(`Saved account: ${saved.identity.accountId} · agent: ${saved.identity.agentId}`);
      expect(tip).toHaveTextContent('Weekly Bot allowance and reset unknown. Separate from Grok Build and xAI API credits.');
      expect(tip).toHaveTextContent('Provider binding unverified.');
      expect(tip).toHaveTextContent('Dispatch not verified.');
      fireEvent.blur(button);
    }
    const reveal = vi.fn(); window.addEventListener(VERSE_ANCHOR_EVENT, reveal);
    try {
      openResources();
      fireEvent.click(screen.getByRole('button', { name: /bot-one · Grok Bot: configured, usage and reset unknown/ }));
      expect((reveal.mock.calls[0]![0] as CustomEvent<VerseAnchorRequest>).detail).toEqual({ section: 'agents', anchor: 'proactive-agents' });
      expect(getResourcesUi().open).toBe(false);
      expect(build).toHaveTextContent(native.value);
    } finally { window.removeEventListener(VERSE_ANCHOR_EVENT, reveal); }
  });

  it('preserves namespaced order across rename/deletion and isolates failed profile reads from native capacity', () => {
    const view = render(<ResourcesBar expanded />);
    fireEvent.click(screen.getByRole('button', { name: 'Move bot-three · Grok Bot up' }));
    const expected = ids(view.container);
    profiles = profiles.filter(saved => saved.id !== 'bot-two').map(saved => saved.id === 'bot-three' ? { ...saved, displayName: 'Renamed Bot' } : saved);
    view.rerender(<ResourcesBar expanded={false} />);
    expect(ids(view.container)).toEqual(expected.filter(id => id !== 'proactive:bot-two'));
    expect(screen.getByRole('button', { name: /Renamed Bot · Grok Bot: configured, usage and reset unknown/ })).toBeInTheDocument();
    vi.mocked(useQuery).mockImplementation(query => ({ data: query.key === proactiveProfilesQuery.key ? { schemaVersion: 1, profiles } : undefined,
      error: query.key === proactiveProfilesQuery.key ? new Error('Metadata unavailable') : undefined } as never));
    view.rerender(<ResourcesBar expanded />);
    expect(ids(view.container)).toEqual(expected.filter(id => id?.startsWith('account:')));
    expect(screen.getByText('72% left')).toBeVisible();
  });

  it('uses only the shared local metadata GET and edit invalidation, with no hidden-bar fetch', async () => {
    evictAll();
    const hooks = await vi.importActual<typeof import('../../../data/hooks.js')>('../../../data/hooks.js');
    vi.mocked(useQuery).mockImplementation((query, options) => query.key === proactiveProfilesQuery.key
      ? hooks.useQuery(query, options) : { data: undefined } as never);
    const { calls } = installFetch(call => call.path === '/api/verse/proactive-agents' && call.method === 'GET'
      ? json({ schemaVersion: 1, profiles }) : json({ error: 'Unexpected request' }, 500));
    setResourcesBar(false);
    const view = render(<ResourcesBar expanded />);
    await act(async () => { await Promise.resolve(); });
    expect(calls).toHaveLength(0);
    act(() => setResourcesBar(true));
    await screen.findByText('bot-one · Grok Bot');
    expect(calls.map(call => [call.path, call.method])).toEqual([['/api/verse/proactive-agents', 'GET']]);
    const second = render(<ResourcesBar expanded={false} />);
    expect(calls).toHaveLength(1);
    profiles = [{ ...profiles[0]!, version: 2, displayName: 'Edited Bot' }];
    const { invalidate } = await import('../../../data/cache.js');
    act(() => invalidate(proactiveProfilesQuery.key));
    await screen.findByText('Edited Bot · Grok Bot');
    expect(calls.map(call => [call.path, call.method])).toEqual(Array.from({ length: 2 }, () => ['/api/verse/proactive-agents', 'GET']));
    second.unmount(); view.unmount();
  });
});

vi.mock('../usage/CapacityStrip.js', async (original) => ({
  ...await original<typeof import('../usage/CapacityStrip.js')>(),
  useCapacityData: vi.fn(),
}));
// Only the shared reads are substituted; rendering exercises the real projection,
// battery and keyboard tooltip without a provider request or extra polling.
vi.mock('../../../data/hooks.js', async (original) => ({
  ...await original<typeof import('../../../data/hooks.js')>(),
  useQuery: vi.fn(() => ({ data: undefined })),
}));
vi.mock('../shell/section-visibility.js', async (original) => ({
  ...await original<typeof import('../shell/section-visibility.js')>(),
  usePollWhileVisible: vi.fn(),
}));

function win(over: Partial<CapacityWindowRow>): CapacityWindowRow {
  return { id: 'seven_day', label: 'weekly window', usedPercent: null, limitReached: false, resetText: 'Sat 8:43 AM', resetsAt: null, binding: true, ...over };
}

function row(over: Partial<CapacityRow>): CapacityRow {
  return {
    seatId: 'grok-a', label: 'Grok', engine: 'grok', monogram: 'G', kind: 'subscription', plan: 'SuperGrok',
    cls: 'usable', word: 'usable', summary: '28% of weekly window used',
    connection: null,
    windows: [win({ usedPercent: 28 })], credits: null, reserve: null, notes: [], localCount: 0,
    checkedAt: new Date(NOW - 60_000).toISOString(), resetAt: null, signedOut: false,
    ...over,
  } as CapacityRow;
}

describe('barRows', () => {
  it('fills the battery with what is left and names the provider', () => {
    const [grok] = barRows([row({})], { healthRead: true, now: NOW });
    expect(grok!.engine).toBe('grok');
    expect(grok!.leftPercent).toBe(72);
    expect(grok!.value).toBe('72% left');
    expect(grok!.detail[0]).toBe('Weekly window: 28% used · resets Sat 8:43 AM');
    expect(grok!.detail.at(-1)).toBe('checked 1m ago');
  });

  it('says "resets" once when the accounts model already worded the reset', () => {
    const [grok] = barRows([row({ windows: [win({ usedPercent: 28, resetText: 'resets Sat 8:43 AM' })] })], { healthRead: true, now: NOW });
    expect(grok!.detail[0]).toBe('Weekly window: 28% used · resets Sat 8:43 AM');
  });

  it('shows a limit-reached account as empty without moving it after usable ones', () => {
    const spent = row({ seatId: 'codex-a', label: 'Personal Codex', engine: 'codex', cls: 'blocked', word: 'blocked',
      windows: [win({ id: 'primary', label: 'primary window', limitReached: true, resetText: 'Fri 2:25 PM' })] });
    const rows = barRows([spent, row({})], { healthRead: true, now: NOW });
    expect(rows.map((r) => r.key)).toEqual(['codex-a', 'grok-a']);
    expect(rows[0]!.leftPercent).toBe(0);
    expect(rows[0]!.level).toBe('out');
  });

  it('does not turn signed-out or unavailable accounts into zero usage', () => {
    const signedOut = row({ signedOut: true, windows: [] });
    const unavailable = row({ seatId: 'claude', cls: 'blocked', windows: [], summary: 'Probe failed.' });
    const projected = barRows([signedOut, unavailable], { healthRead: true, now: NOW });
    expect(projected.map((r) => r.leftPercent)).toEqual([null, null]);
    expect(projected.map((r) => r.value)).toEqual(['signed out', 'unavailable']);
    expect(projected[1]!.detail).toContain('Usage is not reported by this resource.');
  });

  it('keeps order as unknown accounts finish checking', () => {
    const local = row({ seatId: 'local', kind: 'local', engine: 'local', cls: 'unread', windows: [] });
    const initial = [local, row({ cls: 'unread', windows: [] })];
    const completed = [{ ...local, cls: 'ready' as const }, row({})];
    expect(barRows(initial, { healthRead: false, now: NOW }).map((r) => r.key))
      .toEqual(barRows(completed, { healthRead: true, now: NOW }).map((r) => r.key));
  });

  it('shows reading only for real initial collector work, never a connected provider without quota', () => {
    const noQuota = row({ windows: [], cls: 'unread' });
    expect(barRows([noQuota], { healthRead: false, now: NOW })[0]!.value).toBe('no usage');
    expect(barRows([noQuota], { healthRead: false, now: NOW, pendingSeatIds: ['grok-a'] })[0]!.value).toBe('reading…');
  });

  it('projects connected cloud organization consumption without a capacity battery or CLI attribution', () => {
    const consumption = { source: 'devin-v3-organization-daily', scope: 'organization', period: 'all-available-reporting-dates', dateUnit: 'provider-unspecified',
      dayBoundaryUtc: '08:00', state: 'ready', fetchedAt: new Date(NOW - 1000).toISOString(), expiresAt: new Date(NOW + 300_000).toISOString(),
      stale: false, error: null, report: { totalAcus: 3.125, days: [{ date: 123, acus: 3.125, products: { devin: 3.125, cascade: null, terminal: 0, automation: null, review: null } }] } };
    const cloud = row({ seatId: 'devin', engine: 'devin', label: 'Devin (cloud)', windows: [] });
    const cli = row({ seatId: 'devin-cli', engine: 'devin', label: 'Devin (CLI)', windows: [] });
    const projected = barRows([cloud, cli], { healthRead: true, now: NOW, devinConsumption: consumption });
    expect(projected[0]).toMatchObject({ value: '3.1 ACUs consumed', leftPercent: null, level: 'unknown' });
    expect(projected[0]!.detail).toContain('Balance, subscription limits and resets are not reported. No personal CLI allocation is inferred.');
    expect(projected[1]!.value).not.toContain('consumed');
    expect(barRows([cloud], { healthRead: true, now: NOW })[0]!.value).toBe('consumption not reported');
    expect(barRows([cloud], { healthRead: true, now: NOW + 400_000, devinConsumption: consumption })[0]!.value).toBe('3.1 ACUs consumed · last');
  });

  it('labels retained local readiness without changing native quota or guessing observation age', () => {
    const local = row({ seatId: 'local', label: 'Local', engine: 'local', kind: 'local', windows: [], cls: 'ready', checkedAt: new Date(NOW - 120_000).toISOString() });
    const native = row({});
    const [retained, account] = barRows([local, native], { healthRead: true, now: NOW, localReadFailed: true });
    expect(retained).toMatchObject({ value: 'last ready', level: 'unknown', leftPercent: null });
    expect(retained!.detail).toContain('Readiness observation · 2 min ago');
    expect(retained!.detail).toContain('Retained readiness; current availability is unconfirmed.');
    expect(account).toEqual(barRows([native], { healthRead: true, now: NOW })[0]);
    for (const checkedAt of [null, 'bad-time', new Date(NOW + 1).toISOString()]) {
      expect(barRows([{ ...local, checkedAt }], { healthRead: true, now: NOW, localReadFailed: true })[0]!.detail)
        .toContain('Readiness observation · age unavailable');
    }
    expect(barRows([local], { healthRead: true, now: NOW, localReadFailed: false })[0]).toMatchObject({ value: 'ready', level: 'idle' });
  });

  it('gives local models a full idle battery and no percentage', () => {
    const local = row({ seatId: 'local', label: 'Local', engine: 'local', kind: 'local', localCount: 3, windows: [], summary: 'ready' });
    const [l] = barRows([local], { healthRead: true, now: NOW });
    expect(l).toMatchObject({ engine: 'local', name: 'Local models (3)', leftPercent: null, level: 'idle', value: 'ready' });
  });
});

// 3.15: after a weekly reset Grok's probe now reports a measured 0% (xAI omits
// a zero percent); through the one capacity projection that must read as a
// full battery with its reset — not the "—" Mason's rail showed.
describe('Grok right after its weekly reset', () => {
  const grokSeat = (usedPercent: number | null) => {
    const window = seatWindow({ id: 'grok_unified_weekly', usedPercent, resetsAt: '2026-10-03T12:43:50.367Z' });
    return nativeSeat(capacity({ planType: 'SuperGrok', windows: [window], binding: usedPercent === null ? null : window,
      usability: usedPercent === null ? 'unknown' : 'ready', observedAt: new Date(NOW - 30_000).toISOString() }),
    { id: 'grok', engine: 'grok', label: 'Grok', accountId: 'grok' });
  };

  it('shows a full battery, "100% left" and the reset', () => {
    const [grok] = barRows(buildCapacityRows([grokSeat(0)], { now: NOW }), { healthRead: false, now: NOW });
    expect(grok).toMatchObject({ engine: 'grok', leftPercent: 100, level: 'ok', value: '100% left' });
    expect(grok!.detail[0]).toMatch(/weekly window: 0% used · resets \S/);
  });

  it('names missing usage when the provider truly gave no percent', () => {
    const [grok] = barRows(buildCapacityRows([grokSeat(null)], { now: NOW }), { healthRead: false, now: NOW });
    expect(grok!.leftPercent).toBeNull();
    expect(grok!.value).toBe('no usage');
  });
});

describe('the bar switch', () => {
  afterEach(() => { localStorage.removeItem(RESOURCES_STORAGE_KEY); reloadResourcesUiForTest(); });

  it('is on by default and remembers being turned off', () => {
    localStorage.removeItem(RESOURCES_STORAGE_KEY);
    reloadResourcesUiForTest();
    expect(getResourcesUi().bar).toBe(true);
    setResourcesBar(false);
    reloadResourcesUiForTest();
    expect(getResourcesUi().bar).toBe(false);
  });
});

describe('custom resource order', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    vi.mocked(useCapacityData).mockReturnValue({ seats: [
      nativeSeat(capacity(), { id: 'codex-a', engine: 'codex', label: 'Personal Codex' }),
      nativeSeat(capacity(), { id: 'codex-b', engine: 'codex', label: 'Work Codex' }),
    ], health: null, budget: null, loading: false, refreshing: false, readFailed: false, rosterUnavailable: false, pendingSeatIds: [] });
    vi.mocked(useQuery).mockImplementation(query => ({ data: query.key === 'verse-resources-cloud' ? {
      credits: { remainingUsd: 100, totalUsd: 250, running: 0, sessionsToday: 0 },
    } : undefined } as never));
  });
  afterEach(() => { vi.restoreAllMocks(); vi.mocked(useQuery).mockReturnValue({ data: undefined } as never); });

  const ids = (container: HTMLElement) => [...container.querySelectorAll('[data-resource-id]')].map(row => row.getAttribute('data-resource-id'));

  it('moves independent accounts with keyboard controls and restores the same DOM order', () => {
    const first = render(<ResourcesBar expanded />);
    expect(ids(first.container)).toEqual(['account:codex-a', 'account:codex-b', 'budget:cloud']);
    expect(screen.getByRole('button', { name: 'Move Personal Codex up' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Move Work Codex up' }));
    expect(ids(first.container)).toEqual(['account:codex-b', 'account:codex-a', 'budget:cloud']);
    expect(screen.getByRole('status')).toHaveTextContent('Work Codex moved to position 1 of 3.');
    first.unmount(); reloadResourceOrderForTest();
    const reloaded = render(<ResourcesBar expanded={false} />);
    expect(ids(reloaded.container)).toEqual(['account:codex-b', 'account:codex-a', 'budget:cloud']);
    fireEvent.click(screen.getByRole('button', { name: 'Move Work Codex down' }));
    expect(ids(reloaded.container)).toEqual(['account:codex-a', 'account:codex-b', 'budget:cloud']);
  });

  it('drags cloud estimates with accounts and ignores an unrelated external drag', () => {
    const view = render(<ResourcesBar expanded />);
    const row = (id: string) => view.container.querySelector(`[data-resource-id="${id}"]`)!;
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn() };
    fireEvent.dragStart(row('budget:cloud'), { dataTransfer });
    fireEvent.dragOver(row('account:codex-a'), { dataTransfer });
    fireEvent.drop(row('account:codex-a'), { dataTransfer });
    expect(ids(view.container)).toEqual(['budget:cloud', 'account:codex-a', 'account:codex-b']);
    expect(dataTransfer.setData).toHaveBeenCalledWith('application/x-ashlr-resource', 'budget:cloud');
    fireEvent.drop(row('account:codex-b'), { dataTransfer });
    expect(ids(view.container)).toEqual(['budget:cloud', 'account:codex-a', 'account:codex-b']);
  });

  it('ignores removed accounts and appends new accounts without reordering on a reading', () => {
    localStorage.setItem(RESOURCE_ORDER_KEY, JSON.stringify(['account:gone', 'budget:cloud', 'account:codex-b', 'account:codex-a']));
    reloadResourceOrderForTest();
    const view = render(<ResourcesBar expanded />);
    expect(ids(view.container)).toEqual(['budget:cloud', 'account:codex-b', 'account:codex-a']);
    const current = vi.mocked(useCapacityData).getMockImplementation()!();
    vi.mocked(useCapacityData).mockReturnValue({ ...current, seats: [...current.seats,
      nativeSeat(capacity(), { id: 'codex-new', engine: 'codex', label: 'New Codex' })] });
    view.rerender(<ResourcesBar expanded />);
    expect(ids(view.container)).toEqual(['budget:cloud', 'account:codex-b', 'account:codex-a', 'account:codex-new']);
  });

  it('keeps Devin cloud consumption, CLI account and tracked budget independently reorderable', () => {
    vi.mocked(useCapacityData).mockReturnValue({ seats: [
      nativeSeat(capacity(), { id: 'devin', engine: 'devin', label: 'Devin (cloud)' }),
      nativeSeat(capacity(), { id: 'devin-cli', engine: 'devin', label: 'Devin (CLI)' }),
    ], health: null, budget: null, loading: false, refreshing: false, readFailed: false, rosterUnavailable: false, pendingSeatIds: [] });
    vi.mocked(useQuery).mockImplementation(query => ({ data: query.key === 'verse-devin' ? { value: {
      status: { enabled: true, connected: true }, budget: { acuBudgetTotal: 50, acuRemaining: 40, acuUsed: 10, acuInFlight: 0,
        reportedAcuUsed: 10, unconfirmedAcuExposure: 0, paused: false, running: 0, sessionsToday: 0 },
    } } : undefined } as never));
    const view = render(<ResourcesBar expanded />);
    expect(ids(view.container)).toEqual(['account:devin', 'account:devin-cli', 'budget:devin']);
    expect(screen.getByRole('button', { name: /Devin \(cloud\): consumption not reported · remaining quota unknown/ })).toBeInTheDocument();
    expect(screen.getByText('Devin budget')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Move Devin tracked budget up' }));
    expect(ids(view.container)).toEqual(['account:devin', 'budget:devin', 'account:devin-cli']);
  });
});

describe('Devin provider identity', () => {
  it('bundles the exact verified vendor geometry with a theme-aware fill and accessible name', () => {
    const asset = readFileSync(resolve(process.cwd(), 'site/assets/devin-mark.svg'), 'utf8');
    expect(createHash('sha256').update(asset).digest('hex')).toBe('fe0753d2e3823bc1eb8a37943234fac63733b8c9e8abff0ca0402a6c7ddcd682');
    const { getByRole, container } = render(<ProviderLogo engine="devin" title="Devin" />);
    expect(getByRole('img', { name: 'Devin' })).toHaveAttribute('viewBox', '0 0 425 425');
    expect(container.querySelector('path')!.getAttribute('d')).toBe(asset.match(/<path d="([^"]+)"/)![1]);
    expect(container.querySelector('path')).toHaveAttribute('fill', 'currentColor');
  });
});

describe('fresh Devin sidebar readbacks', () => {
  afterEach(() => { vi.mocked(useQuery).mockReset(); vi.mocked(useQuery).mockReturnValue({ data: undefined } as never); vi.restoreAllMocks(); });

  it('accepts a deferred current read immediately, rejects genuine future readings, and expires history', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW);
    vi.mocked(useCapacityData).mockReturnValue({ seats: [nativeSeat(capacity(), { id: 'devin', engine: 'devin', label: 'Devin (cloud)' })],
      health: null, budget: null, loading: false, refreshing: false, readFailed: false, rosterUnavailable: false, pendingSeatIds: [] });
    let consumption: unknown;
    vi.mocked(useQuery).mockImplementation((query) => ({ data: query.key === 'verse-devin' ? { value: {
      status: { enabled: true, connected: true }, budget: { acuBudgetTotal: 50, acuRemaining: 50, acuUsed: 0, acuInFlight: 40,
        reportedAcuUsed: 0, unconfirmedAcuExposure: 40, paused: false, running: 0, sessionsToday: 0 }, consumption,
    } } : undefined } as never));
    const view = render(<ResourcesBar expanded />);
    expect(screen.getByRole('button', { name: 'Devin (cloud): consumption not reported · remaining quota unknown. Open Resources' })).toBeInTheDocument();
    let complete!: (value: unknown) => void;
    const deferred = new Promise<unknown>((resolve) => { complete = resolve; });
    const arrival = deferred.then((value) => { consumption = value; view.rerender(<ResourcesBar expanded />); });
    clock.mockReturnValue(NOW + 5000);
    const reading = { source: 'devin-v3-organization-daily', scope: 'organization', period: 'all-available-reporting-dates', dateUnit: 'provider-unspecified',
      dayBoundaryUtc: '08:00', state: 'ready', fetchedAt: new Date(NOW + 5000).toISOString(), expiresAt: new Date(NOW + 305_000).toISOString(),
      stale: false, error: null, report: { totalAcus: 0, days: [{ date: 123, acus: 0, products: { devin: 0, cascade: 0, terminal: 0, automation: null, review: null } }] } };
    complete(reading); await arrival;
    await waitFor(() => expect(screen.getByRole('button', { name: 'Devin (cloud): 0 ACUs consumed · remaining quota unknown. Open Resources' })).toBeInTheDocument());
    // No local poll was invoked: the arrival itself must use actual time.
    consumption = { ...reading, fetchedAt: new Date(NOW + 60_000).toISOString() };
    view.rerender(<ResourcesBar expanded />);
    expect(screen.getByRole('button', { name: 'Devin (cloud): consumption not reported · remaining quota unknown. Open Resources' })).toBeInTheDocument();
    consumption = { ...reading, report: { totalAcus: 0, days: [] } };
    view.rerender(<ResourcesBar expanded />);
    expect(screen.getByRole('button', { name: 'Devin (cloud): No consumption reported · remaining quota unknown. Open Resources' })).toBeInTheDocument();
    consumption = reading; clock.mockReturnValue(NOW + 400_000); view.rerender(<ResourcesBar expanded />);
    expect(screen.getByRole('button', { name: 'Devin (cloud): 0 ACUs consumed · last · remaining quota unknown. Open Resources' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /40 ACUs held exposure/ })).toBeInTheDocument();
  });
});

describe('Devin tracked exposure in the bar', () => {
  afterEach(() => { vi.mocked(useQuery).mockReset(); vi.mocked(useQuery).mockReturnValue({ data: undefined } as never); });

  it('subtracts unresolved exposure from available headroom and names it in the tooltip', () => {
    vi.mocked(useCapacityData).mockReturnValue({ seats: [], health: null, budget: null, loading: false, refreshing: false, readFailed: false, rosterUnavailable: false, pendingSeatIds: [] });
    vi.mocked(useQuery).mockImplementation((query) => ({ data: query.key === 'verse-devin' ? { value: {
      status: { enabled: true, connected: true },
      budget: { acuBudgetTotal: 50, acuRemaining: 40, acuUsed: 10, acuInFlight: 8,
        reportedAcuUsed: 2, unconfirmedAcuExposure: 18, paused: false, running: 1, sessionsToday: 2 },
    } } : undefined } as never));
    render(<ResourcesBar expanded />);
    const devin = screen.getByRole('button', { name: /Devin tracked budget: 30 ACUs of 50 ACUs available, 18 ACUs held exposure/ });
    expect(within(devin).getByText('30 ACUs budget')).toBeInTheDocument();
    fireEvent.focus(devin);
    expect(screen.getByRole('tooltip')).toHaveTextContent('2 ACUs reported usage + adjustment · 18 ACUs held exposure');
    expect(devin.querySelector('[aria-hidden="true"][data-level] > [style]')).toHaveStyle({ '--fill': '60%' });
  });

  it.each(['missing', 'unavailable'])('keeps %s local Devin capacity unknown without changing provider quota', accountingState => {
    vi.mocked(useCapacityData).mockReturnValue({ seats: [], health: null, budget: null, loading: false, refreshing: false, readFailed: false, rosterUnavailable: false, pendingSeatIds: [] });
    vi.mocked(useQuery).mockImplementation(query => ({ data: query.key === 'verse-devin' ? { value: {
      status: { enabled: true, connected: true },
      budget: { acuBudgetTotal: 50, acuRemaining: 50, acuUsed: 0, acuInFlight: 0, accountingState,
        reportedAcuUsed: 0, unconfirmedAcuExposure: 0, paused: false, running: 0, sessionsToday: 0 },
    } } : undefined } as never));
    render(<ResourcesBar expanded />);
    const row = screen.getByRole('button', { name: 'Devin tracked budget capacity unknown: task evidence unavailable. Open Resources' });
    expect(row).toHaveAttribute('data-level', 'unknown');
    expect(screen.getByText('Capacity unknown')).toBeInTheDocument();
    fireEvent.focus(row);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Local budget capacity unknown');
    expect(screen.getByRole('tooltip')).not.toHaveTextContent('ACUs of');
  });

  it('shows a new-chat admission pause without turning held exposure into spent usage or a provider quota', () => {
    const reason = 'Another session could take today past the 30 ACUs daily cap (40 ACUs used or held).';
    vi.mocked(useCapacityData).mockReturnValue({ seats: [], health: null, budget: null, loading: false, refreshing: false, readFailed: false, rosterUnavailable: false, pendingSeatIds: [] });
    vi.mocked(useQuery).mockImplementation((query) => ({ data: query.key === 'verse-devin' ? { value: {
      status: { enabled: true, connected: true },
      budget: { acuBudgetTotal: 50, acuRemaining: 10, acuUsed: 40, acuInFlight: 0,
        reportedAcuUsed: 0, unconfirmedAcuExposure: 40, paused: false, running: 0, sessionsToday: 0,
        canLaunch: { ok: false, reason } },
    } } : undefined } as never));
    render(<ResourcesBar expanded />);
    const devin = screen.getByRole('button', { name: `Devin tracked budget: 10 ACUs of 50 ACUs available, 40 ACUs held exposure. New chats paused: ${reason}. Open Resources` });
    expect(within(devin).getByText('10 ACUs budget')).toBeInTheDocument();
    expect(within(devin).getByText('New chats paused')).toBeInTheDocument();
    expect(devin).toHaveAttribute('data-level', 'ok');
    expect(devin.querySelector('[aria-hidden="true"][data-level] > [style]')).toHaveStyle({ '--fill': '20%' });
    fireEvent.focus(devin);
    expect(screen.getByRole('tooltip')).toHaveTextContent(`New chats paused: ${reason}`);
    expect(screen.getByRole('tooltip')).toHaveTextContent('0 ACUs reported usage + adjustment · 40 ACUs held exposure');
    expect(within(devin).queryByText(/spent|% left/i)).not.toBeInTheDocument();
  });
});

describe('Codex credits are independent of the quota battery', () => {
  it('shows native credits and estimated value when the window is spent without filling the battery', () => {
    const account = row({ engine: 'codex', plan: 'pro', cls: 'tight', credits: '2,000 credits available',
      creditBalance: '2048.4196250000', connection: { connection: 'exhausted' } as CapacityRow['connection'],
      windows: [win({ usedPercent: 100, limitReached: true })] });
    const result = barRows([account], { healthRead: true, now: NOW })[0]!;
    expect(result.value).toBe('100% used'); expect(result.leftPercent).toBe(0);
    expect(result.creditLabel).toBe('Credits ≈$82'); expect(result.level).toBe('out');
    expect(result.summary).toContain('Credits available');
    expect(result.summary).toContain('estimated credit value $82');
    expect(result.detail).toContain('2,000 credits available');
    expect(result.exactCreditBalance).toBe('2048.4196250000');
    expect(result.detail.join(' ')).not.toContain('2048.4196250000');
    expect(result.detail.some((line) => line.includes('Estimated credit value $82'))).toBe(true);
    expect(result.detail.some((line) => line.includes('autonomous credit spending is not admitted'))).toBe(true);
  });
  it('reports a vendor spend-control hold separately from its remaining balance', () => {
    const result = barRows([row({ engine: 'codex', credits: '12 credits available', creditSpendControlReached: true,
      windows: [win({ usedPercent: 100 })] })], { healthRead: true, now: NOW })[0]!;
    expect(result.value).toBe('100% used'); expect(result.creditHeld).toBe(true);
    expect(result.creditLabel).toBe('12 credits available'); expect(result.summary).toContain('Credits held');
    expect(result.detail).toContain('12 credits available'); expect(result.leftPercent).toBe(0);
  });
  it('never publishes stale or signed-out credits as currently available', () => {
    for (const patch of [{ signedOut: true }, { lastReading: true }]) {
      const result = barRows([row({ engine: 'codex', plan: 'pro', creditBalance: '12', credits: '12 credits available', ...patch })], { healthRead: true, now: NOW })[0]!;
      expect(result.creditLabel).toBe('Credits unconfirmed');
      expect(result.summary).not.toContain('estimated credit value');
      expect(result.detail.join(' ')).not.toContain('Estimated credit value');
    }
  });
  it('keeps unsupported plan balances in provider units without inventing a dollar rate', () => {
    const result = barRows([row({ engine: 'codex', plan: 'enterprise', creditBalance: '12', credits: '12 credits available' })], { healthRead: true, now: NOW })[0]!;
    expect(result.value).toBe('28% used');
    expect(result.creditLabel).toBe('12 credits available');
    expect(result.summary).not.toContain('estimated credit value');
    expect(result.detail.join(' ')).not.toContain('Estimated credit value');
  });

  it('retains unknown quota independently of known credits and unknown credits independently of known quota', () => {
    const projected = barRows([
      row({ seatId: 'codex-a', engine: 'codex', windows: [], credits: '12 credits available', plan: 'pro', creditBalance: '12' }),
      row({ seatId: 'codex-b', engine: 'codex', windows: [win({ usedPercent: 0 })], credits: null, creditState: 'unknown' }),
    ], { healthRead: true, now: NOW });
    expect(projected[0]).toMatchObject({ value: 'no usage', leftPercent: null, level: 'unknown', creditLabel: 'Credits ≈$0.48' });
    expect(projected[1]).toMatchObject({ value: '0% used', leftPercent: 100, creditLabel: 'Credits not reported' });
  });

  it('never invents measured percentages from limit flags or an exhausted connection', () => {
    const projected = barRows([
      row({ engine: 'codex', windows: [win({ usedPercent: null, limitReached: true })] }),
      row({ engine: 'codex', windows: [win({ usedPercent: 33, limitReached: true })] }),
      row({ engine: 'codex', windows: [], connection: { connection: 'exhausted' } as CapacityRow['connection'] }),
    ], { healthRead: true, now: NOW });
    expect(projected[0]).toMatchObject({ value: 'limit reached', leftPercent: 0, level: 'out' });
    expect(projected[1]).toMatchObject({ value: '33% used · limit reached', leftPercent: 0, level: 'out' });
    expect(projected[2]).toMatchObject({ value: 'no usage', leftPercent: null, level: 'unknown' });
  });

  it('labels historical measured usage as used and never treats historical limit flags as measured 100%', () => {
    const projected = barRows([28, null, 100].map((usedPercent, index) => row({ engine: 'codex', windows: [],
      historicalUsage: { source: 'native-account-checked-history', identitySource: 'native-account-checked',
        observedAt: new Date(NOW - 120_000).toISOString(), expiresAt: new Date(NOW - 60_000).toISOString(),
        windows: [{ id: 'primary', usedPercent, resetsAt: null, ...(index === 0 ? {} : { limitReached: true }) }] },
    })), { healthRead: true, now: NOW });
    expect(projected[0]).toMatchObject({ value: '28% used · last', leftPercent: 72, level: 'unknown' });
    for (const flagged of projected.slice(1)) {
      expect(flagged).toMatchObject({ value: 'limit was reached · last', leftPercent: 0, level: 'unknown' });
      expect(flagged!.summary).not.toContain('100%');
      expect(flagged!.detail.join(' ')).not.toContain('100%');
    }
  });

  it('keeps historical quota explicit and current credits independent of quota history', () => {
    const projected = barRows([row({ engine: 'codex', windows: [], credits: '12 credits available', creditBalance: '12',
      historicalUsage: { source: 'native-account-checked-history', identitySource: 'native-account-checked',
        observedAt: new Date(NOW - 120_000).toISOString(), expiresAt: new Date(NOW - 60_000).toISOString(),
        windows: [{ id: 'primary', usedPercent: 78, resetsAt: null }] },
    })], { healthRead: true, now: NOW })[0]!;
    expect(projected).toMatchObject({ value: '78% used · last', level: 'unknown', leftPercent: 22 });
    expect(projected.creditLabel).toBe('12 credits available');
    expect(projected.detail).toContain('12 credits available');
    expect(projected.summary).toContain('current usage unconfirmed');
    const stale = barRows([row({ engine: 'codex', windows: [], lastReading: true,
      credits: '12 credits available', historicalUsage: { source: 'native-account-checked-history', identitySource: 'native-account-checked',
        observedAt: new Date(NOW - 120_000).toISOString(), expiresAt: new Date(NOW - 60_000).toISOString(),
        windows: [{ id: 'primary', usedPercent: 78, resetsAt: null }] },
    })], { healthRead: true, now: NOW })[0]!;
    expect(stale).toMatchObject({ value: '78% used · last', creditLabel: 'Credits unconfirmed' });
    expect(stale.detail).not.toContain('12 credits available');
  });
});

describe('visible Codex subscription and credit balances', () => {
  beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(NOW); });
  afterEach(() => { vi.restoreAllMocks(); });

  function showAccounts(expanded: boolean, held = false) {
    const personalWindow = seatWindow({ id: 'codex_primary', usedPercent: 100, limitReached: false, resetsAt: '2026-10-03T12:00:00.000Z' });
    const cmpWeekly = seatWindow({ id: 'codex_weekly', usedPercent: 27, resetsAt: '2026-10-03T12:00:00.000Z' });
    const cmpSession = seatWindow({ id: 'codex_session', usedPercent: 63, resetsAt: '2026-09-25T06:00:00.000Z' });
    vi.mocked(useCapacityData).mockReturnValue({ seats: [
      nativeSeat(capacity({ planType: 'pro', windows: [personalWindow], binding: personalWindow, usability: 'tight',
        observedAt: new Date(NOW - 30_000).toISOString(),
        credits: { hasCredits: true, unlimited: false, balance: '2048.4196250000', spendControlReached: held },
      }), { id: 'codex-personal', engine: 'codex', label: 'Personal Codex', accountId: 'codex-personal' }),
      nativeSeat(capacity({ planType: 'pro', windows: [cmpWeekly, cmpSession], binding: cmpSession, usability: 'ready',
        observedAt: new Date(NOW - 30_000).toISOString(), credits: { hasCredits: true, unlimited: false, balance: '250' },
      }), { id: 'codex-cmp', engine: 'codex', label: 'Cash Margin Partners', accountId: 'codex-cmp' }),
    ], health: null, budget: null, loading: false, refreshing: false, readFailed: false, rosterUnavailable: false, pendingSeatIds: [] });
    return render(<ResourcesBar expanded={expanded} />);
  }

  it('renders both percentages and both account balances without filling a spent subscription battery', () => {
    showAccounts(true);
    const personal = screen.getByRole('button', { name: /^Personal Codex:/ });
    const cmp = screen.getByRole('button', { name: /^Cash Margin Partners:/ });
    expect(within(personal).getByText('100% used')).toBeInTheDocument();
    expect(within(personal).getByText('Credits ≈$82')).toBeInTheDocument();
    expect(personal).toHaveAttribute('title', 'Provider balance: 2,000 credits.');
    expect(personal.getAttribute('aria-label')).not.toContain('2048.4196250000');
    expect(personal.textContent).not.toContain('2048.4196250000');
    expect(within(cmp).getByText('63% used')).toBeInTheDocument();
    expect(within(cmp).getByText('Credits ≈$10')).toBeInTheDocument();
    expect(personal.querySelector('[aria-hidden="true"][data-level] > [style]')).toHaveStyle({ '--fill': '0%' });
    expect(cmp.querySelector('[aria-hidden="true"][data-level] > [style]')).toHaveStyle({ '--fill': '37%' });
  });

  it('shows a spending hold beside the balance while keeping quota independent', () => {
    showAccounts(true, true);
    const personal = screen.getByRole('button', { name: /^Personal Codex:/ });
    expect(within(personal).getByText('100% used')).toBeInTheDocument();
    expect(within(personal).getByText('Credits ≈$82')).toBeInTheDocument();
    expect(within(personal).getByText('Held')).toBeInTheDocument();
    expect(personal).toHaveAccessibleName(/credit spending held/);
    expect(within(screen.getByRole('button', { name: /^Cash Margin Partners:/ })).queryByText('Held')).toBeNull();
  });

  it('keeps the independent quota, credits and every window in collapsed keyboard tooltips', () => {
    showAccounts(false);
    const cmp = screen.getByRole('button', { name: /^Cash Margin Partners:/ });
    expect(cmp).toHaveAccessibleName(/subscription 63% used.*Credits ≈\$10/);
    fireEvent.focus(cmp);
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip.textContent).toContain('63% used');
    expect(tooltip.textContent).toContain('27% used');
    expect(tooltip.textContent).toContain('250 credits available');
    expect(tooltip.textContent).toContain('Estimated credit value $10');
  });
});

describe('readable historical native credit units', () => {
  it('uses reported instead of interpolating a malformed historical balance into native units', () => {
    const projected = barRows([row({ engine: 'codex', lastReading: true, historicalCredits: {
      observedAt: new Date(NOW - 30_000).toISOString(), expiresAt: new Date(NOW - 1).toISOString(), planType: 'pro',
      reading: { hasCredits: true, unlimited: false, balance: '1e6' },
    } })], { healthRead: true, now: NOW })[0]!;
    expect(projected.creditLabel).toBe('Credits reported · last');
    expect(projected.detail.join(' ')).toContain('current balance and availability are unconfirmed');
    expect(projected.detail.join(' ')).not.toContain('Estimated credit value');
    expect(projected.creditHeld).toBe(false);
  });
  it('keeps independent account balances, exact detail and historical status without inventing a dollar rate', () => {
    const projected = barRows([
      row({ seatId: 'codex-small', engine: 'codex', lastReading: true, historicalCredits: {
        observedAt: new Date(NOW - 30_000).toISOString(), expiresAt: new Date(NOW - 1).toISOString(), planType: 'enterprise',
        reading: { hasCredits: true, unlimited: false, balance: '0.000001' },
      } }),
      row({ seatId: 'codex-large', engine: 'codex', lastReading: true, historicalCredits: {
        observedAt: new Date(NOW - 30_000).toISOString(), expiresAt: new Date(NOW - 1).toISOString(), planType: null,
        reading: { hasCredits: true, unlimited: false, balance: '62497.7860000000' },
      } }),
    ], { healthRead: true, now: NOW });
    expect(projected[0]!.creditLabel).toBe('Credits 0.000001 units · last');
    expect(projected[1]!.creditLabel).toBe('Credits 62,000 units · last');
    expect(projected[0]!.exactCreditBalance).toBe('0.000001');
    expect(projected[1]!.exactCreditBalance).toBe('62497.7860000000');
    expect(projected[1]!.detail.join(' ')).not.toContain('62497.7860000000');
    for (const value of projected) {
      expect(value.detail.join(' ')).toContain('current balance and availability are unconfirmed');
      expect(value.detail.join(' ')).not.toContain('Estimated credit value');
      expect(value.creditHeld).toBe(false);
    }
  });
});


describe('Devin sidebar cached refresh lifetime', () => {
  let fetch: MockInstance<typeof devinQuery.fetch>;
  let overview: unknown;
  const setVisible = (state: 'visible' | 'hidden') => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    document.dispatchEvent(new Event('visibilitychange'));
  };
  const pending = { source: 'devin-v3-organization-daily', scope: 'organization', period: 'all-available-reporting-dates', dateUnit: 'provider-unspecified',
    dayBoundaryUtc: '08:00', state: 'not-checked', report: null, fetchedAt: null, checkedAt: null, expiresAt: null, retryAt: null, stale: false, error: null };
  const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
  const mount = (visible = true) => render(<SectionVisibilityProvider visible={visible}><ResourcesBar expanded /></SectionVisibilityProvider>);

  beforeEach(async () => {
    evictAll();
    localStorage.removeItem(RESOURCES_STORAGE_KEY); reloadResourcesUiForTest();
    vi.useFakeTimers(); vi.setSystemTime(NOW); setVisible('visible');
    const hooks = await vi.importActual<typeof import('../../../data/hooks.js')>('../../../data/hooks.js');
    const visibility = await vi.importActual<typeof import('../shell/section-visibility.js')>('../shell/section-visibility.js');
    // Keep unrelated reads mocked, but exercise Devin's real shared cache and timer lifecycle.
    vi.mocked(useQuery).mockImplementation((query, options) => query.key === devinQuery.key
      ? hooks.useQuery(query, options) : { data: undefined } as never);
    vi.mocked(usePollWhileVisible).mockImplementation(visibility.usePollWhileVisible);
    vi.mocked(useCapacityData).mockReturnValue({ seats: [nativeSeat(capacity(), { id: 'devin', engine: 'devin', label: 'Devin (cloud)' })],
      health: null, budget: null, loading: false, refreshing: false, readFailed: false, rosterUnavailable: false, pendingSeatIds: [] });
    overview = { value: { status: { enabled: true, connected: true }, budget: { acuBudgetTotal: 50, acuRemaining: 50, acuUsed: 0,
      acuInFlight: 0, reportedAcuUsed: 0, unconfirmedAcuExposure: 0, paused: false, running: 0, sessionsToday: 0 } } };
    fetch = vi.spyOn(devinQuery, 'fetch').mockImplementation(async () => overview as never);
  });
  afterEach(() => {
    cleanup(); evictAll(); vi.useRealTimers(); setVisible('visible'); vi.restoreAllMocks();
    vi.mocked(useQuery).mockReturnValue({ data: undefined } as never);
    vi.mocked(usePollWhileVisible).mockImplementation(() => {});
    localStorage.removeItem(RESOURCES_STORAGE_KEY); reloadResourcesUiForTest();
  });

  it('catches actual startup consumption within five seconds, then returns to the regular cadence', async () => {
    overview = { value: { ...(overview as { value: object }).value, consumption: pending } };
    const view = mount(); await advance(0);
    expect(screen.getByRole('button', { name: /Devin \(cloud\): consumption not reported · remaining quota unknown/ })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
    overview = { value: { ...(overview as { value: object }).value, consumption: {
      source: 'devin-v3-organization-daily', scope: 'organization', period: 'all-available-reporting-dates', dateUnit: 'provider-unspecified',
      dayBoundaryUtc: '08:00', state: 'ready', fetchedAt: new Date(NOW + 5_000).toISOString(),
      expiresAt: new Date(NOW + 305_000).toISOString(), stale: false, error: null,
      report: { totalAcus: 3.125, days: [{ date: 123, acus: 3.125, products: { devin: 3.125, cascade: null, terminal: 0, automation: null, review: null } }] },
    } } };
    view.rerender(<SectionVisibilityProvider visible><ResourcesBar expanded /></SectionVisibilityProvider>);
    await advance(4_999); expect(fetch).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: /Devin \(cloud\): 3.1 ACUs consumed · remaining quota unknown/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Devin tracked budget: 50 ACUs of 50 ACUs available, 0 ACUs held exposure. Open Resources' })).toBeInTheDocument();
    await advance(DEVIN_POLL_MS - 1); expect(fetch).toHaveBeenCalledTimes(2);
    await advance(1); expect(fetch).toHaveBeenCalledTimes(3);
    view.unmount(); await advance(DEVIN_POLL_MS * 2); expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('pauses for hidden sections, hidden documents, disabled bars and the drawer refresh owner', async () => {
    const view = mount(); await advance(0);
    view.rerender(<SectionVisibilityProvider visible={false}><ResourcesBar expanded /></SectionVisibilityProvider>);
    await advance(DEVIN_POLL_MS * 2); expect(fetch).toHaveBeenCalledTimes(1);
    view.rerender(<SectionVisibilityProvider visible><ResourcesBar expanded /></SectionVisibilityProvider>);
    await advance(0); expect(fetch).toHaveBeenCalledTimes(2);
    act(() => setVisible('hidden')); await advance(DEVIN_POLL_MS * 2); expect(fetch).toHaveBeenCalledTimes(2);
    act(() => setVisible('visible')); await advance(0); expect(fetch).toHaveBeenCalledTimes(3);
    act(() => setResourcesBar(false)); await advance(DEVIN_POLL_MS * 2); expect(fetch).toHaveBeenCalledTimes(3);
    act(() => setResourcesBar(true)); act(() => openResources());
    await advance(DEVIN_POLL_MS * 2); expect(fetch).toHaveBeenCalledTimes(3);
    act(() => closeResources()); await advance(DEVIN_POLL_MS); expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('coalesces simultaneous mounted sidebar readers through the existing shared query', async () => {
    const first = mount(); const second = mount(); await advance(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    let complete!: () => void;
    fetch.mockImplementationOnce(() => new Promise(resolve => { complete = () => resolve(overview as never); }));
    await advance(DEVIN_POLL_MS); expect(fetch).toHaveBeenCalledTimes(2);
    await act(async () => { complete(); });
    first.unmount(); second.unmount(); await advance(DEVIN_POLL_MS * 2); expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('limits a collector that stays pending to the startup minute', async () => {
    overview = { value: { ...(overview as { value: object }).value, consumption: { ...pending, state: 'reading' } } };
    const view = mount(); await advance(0);
    expect(screen.getByRole('button', { name: /reading consumption… · remaining quota unknown/ })).toBeInTheDocument();
    await advance(DEVIN_POLL_MS); const afterStartup = fetch.mock.calls.length;
    expect(afterStartup).toBeGreaterThan(1); expect(afterStartup).toBeLessThanOrEqual(13);
    await advance(DEVIN_POLL_MS - 1); expect(fetch).toHaveBeenCalledTimes(afterStartup);
    await advance(1); expect(fetch).toHaveBeenCalledTimes(afterStartup + 1);
    view.unmount();
  });

  it('returns to regular cached reads on a real unavailable response without touching provider backoff', async () => {
    overview = { value: { ...(overview as { value: object }).value, consumption: pending } };
    const view = mount(); await advance(0);
    const retryAt = new Date(NOW + 300_000).toISOString();
    overview = { value: { ...(overview as { value: object }).value, consumption: { ...pending, state: 'unavailable', retryAt,
      error: { code: 'rate-limited', reason: 'Devin rate-limited this consumption read.' } } } };
    await advance(5_000); expect(fetch).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: /consumption not reported · remaining quota unknown/ })).toBeInTheDocument();
    await advance(DEVIN_POLL_MS - 1); expect(fetch).toHaveBeenCalledTimes(2);
    await advance(1); expect(fetch).toHaveBeenCalledTimes(3);
    expect((overview as { value: { consumption: { retryAt: string } } }).value.consumption.retryAt).toBe(retryAt);
    view.unmount();
  });

  it('does not fast-poll missing old-server consumption or a disconnected account', async () => {
    const view = mount(); await advance(0); await advance(5_000); expect(fetch).toHaveBeenCalledTimes(1);
    overview = { value: { ...(overview as { value: object }).value, status: { enabled: true, connected: false }, consumption: pending } };
    await advance(DEVIN_POLL_MS - 5_000); expect(fetch).toHaveBeenCalledTimes(2);
    await advance(DEVIN_POLL_MS - 1); expect(fetch).toHaveBeenCalledTimes(2);
    await advance(1); expect(fetch).toHaveBeenCalledTimes(3);
    view.unmount();
  });


  it('retains an unknown pending snapshot after a failed cache GET and slows retry cadence', async () => {
    overview = { value: { ...(overview as { value: object }).value, consumption: pending } };
    const view = mount(); await advance(0);
    fetch.mockRejectedValueOnce(new Error('The local cached overview could not be read.'));
    await advance(5_000); expect(fetch).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: /consumption not reported · remaining quota unknown/ })).toBeInTheDocument();
    await advance(DEVIN_POLL_MS - 1); expect(fetch).toHaveBeenCalledTimes(2);
    await advance(1); expect(fetch).toHaveBeenCalledTimes(3);
    view.unmount();
  });

});


describe('recorded Claude API promotion in the resource bar', () => {
  let recorded: CreditPoolsReadV2;
  const apiRow = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-resource-id="budget:claude-api-promotions"]')!;
  beforeEach(() => {
    localStorage.removeItem(RESOURCES_STORAGE_KEY); reloadResourcesUiForTest(); closeResources();
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    vi.mocked(useCapacityData).mockReturnValue({ seats: [nativeSeat(capacity(), { id: 'claude', engine: 'claude', label: 'Claude subscription' })],
      health: null, budget: null, loading: false, refreshing: false, readFailed: false, rosterUnavailable: false, pendingSeatIds: [] });
    recorded = { v: 2, state: 'warming', refreshedAt: null, pools: null, apiGrants: { v: 1, state: 'healthy', rows: [{
      v: 1, state: 'recorded', remainingUsdMicros: '200000000', totalUsdMicros: '200000000',
      capturedAt: '2026-10-09T12:00:00.000Z', expiryDate: '2026-10-24', admissionCutoff: '2026-10-24T00:00:00.000Z',
      cutoffPolicy: 'expiry-day-start/v1', automaticAdmission: 'held',
    }] } };
    vi.mocked(useQuery).mockImplementation(query => ({ data: query.key === creditPoolsQuery.key
      ? { value: recorded, available: true, reason: null } : undefined } as never));
  });
  afterEach(() => {
    cleanup(); closeResources(); vi.restoreAllMocks(); vi.mocked(useQuery).mockReturnValue({ data: undefined } as never);
    localStorage.removeItem(RESOURCES_STORAGE_KEY); reloadResourcesUiForTest();
  });

  it('shows recorded dollars and Held separately from the unchanged subscription, opens Resources and explains the hold', async () => {
    const view = render(<ResourcesBar expanded />);
    const api = within(apiRow(view.container));
    const button = api.getByRole('button', { name: /Claude API promotion: \$200 last recorded.*held.*Open Resources/ });
    expect(api.getByText('$200 last recorded')).toBeVisible(); expect(api.getByText('Held')).toBeVisible();
    expect(button).toHaveAttribute('title', 'Recorded balance: $200');
    expect(apiRow(view.container).querySelector('[class*="battery"]')).toBeNull();
    expect(view.container.querySelector('[data-resource-id="account:claude"]')).not.toBeNull();
    fireEvent.focus(button);
    expect(await screen.findByText('Expires 2026-10-24 UTC')).toBeVisible();
    expect(screen.getByText(/billing, account binding and signed API authority need verification/)).toBeVisible();
    fireEvent.click(button); expect(getResourcesUi().open).toBe(true);
  });

  it('keeps dollars and Held visible in the compact rail without manufacturing capacity', () => {
    const view = render(<ResourcesBar expanded={false} />); const api = within(apiRow(view.container));
    expect(api.getByText('$200')).toBeVisible(); expect(api.getByText('Held')).toBeVisible();
    expect(apiRow(view.container)).not.toHaveTextContent('%');
    expect(apiRow(view.container).querySelector('[class*="battery"]')).toBeNull();
  });

  it.each([['0', '$0 last recorded'], [null, 'API promotional balance unknown']] as const)(
    'keeps recorded %s distinct from unknown and never enables use', (micros, label) => {
      recorded.apiGrants.rows[0]!.remainingUsdMicros = micros;
      const view = render(<ResourcesBar expanded />); const api = within(apiRow(view.container));
      expect(api.getByText(label)).toBeVisible(); expect(api.getByText('Held')).toBeVisible();
    });

  it('counts multiple records without summing dollars or inventing an account identity', async () => {
    recorded.apiGrants.rows.push({ ...recorded.apiGrants.rows[0]!, remainingUsdMicros: '100000000' });
    const view = render(<ResourcesBar expanded />); const api = within(apiRow(view.container));
    expect(api.getByText('2 records')).toBeVisible(); expect(api.queryByText('$300')).toBeNull();
    fireEvent.focus(api.getByRole('button', { name: /Claude API promotion: 2 records/ }));
    expect(await screen.findByText('$200 last recorded')).toBeVisible(); expect(screen.getByText('$100 last recorded')).toBeVisible();
    expect(view.container.querySelectorAll('[data-resource-id^="account:"]')).toHaveLength(1);
  });

  it('does not manufacture a promotion from an older, empty, unavailable or failed read', () => {
    for (const value of [{ v: 1, state: 'warming', refreshedAt: null, pools: null },
      { ...recorded, apiGrants: { v: 1, state: 'missing', rows: [] } },
      { ...recorded, apiGrants: { v: 1, state: 'unavailable', rows: [] } }, null]) {
      vi.mocked(useQuery).mockImplementation(query => ({ data: query.key === creditPoolsQuery.key ? { value } : undefined } as never));
      const view = render(<ResourcesBar expanded />); expect(apiRow(view.container)).toBeNull(); view.unmount();
    }
    vi.mocked(useQuery).mockImplementation(query => ({ data: query.key === creditPoolsQuery.key ? { value: recorded } : undefined,
      error: new Error('read failed') } as never));
    const view = render(<ResourcesBar expanded />); expect(apiRow(view.container)).toBeNull();
  });

  it('reuses the shared cache and existing visible cadence without polling an open drawer or hidden bar', () => {
    const view = render(<ResourcesBar expanded />);
    expect(useQuery).toHaveBeenCalledWith(creditPoolsQuery, { enabled: true, freshMs: 15_000 });
    expect(usePollWhileVisible).toHaveBeenCalledWith(expect.any(Function), 15_000, { enabled: true });
    openResources(); view.rerender(<ResourcesBar expanded />);
    expect(usePollWhileVisible).toHaveBeenCalledWith(expect.any(Function), 15_000, { enabled: false });
    setResourcesBar(false); view.rerender(<ResourcesBar expanded />);
    expect(useQuery).toHaveBeenCalledWith(creditPoolsQuery, { enabled: false, freshMs: 15_000 });
  });
});


describe('API promotion cold-start cached refresh', () => {
  let value: CreditPoolsRead;
  let fetch: MockInstance<typeof creditPoolsQuery.fetch>;
  const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
  const mount = () => render(<SectionVisibilityProvider visible><ResourcesBar expanded /></SectionVisibilityProvider>);
  beforeEach(async () => {
    evictAll(); localStorage.removeItem(RESOURCES_STORAGE_KEY); reloadResourcesUiForTest(); closeResources();
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    const hooks = await vi.importActual<typeof import('../../../data/hooks.js')>('../../../data/hooks.js');
    const visibility = await vi.importActual<typeof import('../shell/section-visibility.js')>('../shell/section-visibility.js');
    vi.mocked(useQuery).mockImplementation((query, options) => query.key === creditPoolsQuery.key
      ? hooks.useQuery(creditPoolsQuery, options) : { data: undefined } as never);
    vi.mocked(usePollWhileVisible).mockImplementation(visibility.usePollWhileVisible);
    vi.mocked(useCapacityData).mockReturnValue({ seats: [], health: null, budget: null, loading: false, refreshing: false,
      readFailed: false, rosterUnavailable: false, pendingSeatIds: [] });
    value = { v: 1, state: 'warming', refreshedAt: null, pools: null };
    fetch = vi.spyOn(creditPoolsQuery, 'fetch').mockImplementation(async () => ({ value, available: true, reason: null }));
  });
  afterEach(() => {
    cleanup(); evictAll(); vi.useRealTimers(); vi.restoreAllMocks();
    vi.mocked(useQuery).mockReturnValue({ data: undefined } as never); vi.mocked(usePollWhileVisible).mockImplementation(() => {});
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    localStorage.removeItem(RESOURCES_STORAGE_KEY); reloadResourcesUiForTest(); closeResources();
  });

  it('receives the real cached API view after two seconds and stops quick polling while native pools still warm', async () => {
    mount(); await advance(0); expect(fetch).toHaveBeenCalledTimes(1);
    value = { v: 2, state: 'warming', refreshedAt: null, pools: null, apiGrants: { v: 1, state: 'healthy', rows: [{
      v: 1, state: 'recorded', remainingUsdMicros: '200000000', totalUsdMicros: '200000000', capturedAt: new Date(NOW).toISOString(),
      expiryDate: '2026-10-24', admissionCutoff: '2026-10-24T00:00:00.000Z', cutoffPolicy: 'expiry-day-start/v1', automaticAdmission: 'held',
    }] } };
    await advance(1999); expect(fetch).toHaveBeenCalledTimes(1); expect(screen.queryByText('$200 last recorded')).toBeNull();
    await advance(1); expect(fetch).toHaveBeenCalledTimes(2); expect(screen.getByText('$200 last recorded')).toBeVisible();
    await advance(14_999); expect(fetch).toHaveBeenCalledTimes(2);
    await advance(1); expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('bounds cold polling to thirty seconds and preserves document and section visibility pauses', async () => {
    const view = mount(); await advance(0); await advance(30_000);
    const afterCold = fetch.mock.calls.length; expect(afterCold).toBe(16);
    await advance(14_999); expect(fetch).toHaveBeenCalledTimes(afterCold);
    await advance(1); expect(fetch).toHaveBeenCalledTimes(afterCold + 1);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await advance(30_000); expect(fetch).toHaveBeenCalledTimes(afterCold + 1);
    view.rerender(<SectionVisibilityProvider visible={false}><ResourcesBar expanded /></SectionVisibilityProvider>);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await advance(30_000); expect(fetch).toHaveBeenCalledTimes(afterCold + 1);
  });
});
