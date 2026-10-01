/**
 * ResourcesBar — the always-on resource bar (3.11.1): batteries show what is
 * LEFT of each account's binding window, roster order stays fixed, spent ones read
 * as empty red batteries, and the bar's on/off choice persists.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { render } from '@testing-library/react';
import { ProviderLogo } from '../../../components/primitives/ProviderLogo.js';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCapacityRows, type CapacityRow, type CapacityWindowRow } from '../usage/capacity-strip-model.js';
import { capacity, nativeSeat, seatWindow } from '../seat-fixtures.test-support.js';
import { barRows } from './ResourcesBar.js';
import { getResourcesUi, reloadResourcesUiForTest, RESOURCES_STORAGE_KEY, setResourcesBar } from './resources-store.js';

const NOW = Date.parse('2026-09-25T02:00:00Z');

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


describe('Codex credits are independent of the quota battery', () => {
  it('shows native credits and estimated value when the window is spent without filling the battery', () => {
    const account = row({ engine: 'codex', plan: 'pro', cls: 'tight', credits: '2048.4196250000 credits available',
      creditBalance: '2048.4196250000', connection: { connection: 'exhausted' } as CapacityRow['connection'],
      windows: [win({ usedPercent: 100, limitReached: true })] });
    const result = barRows([account], { healthRead: true, now: NOW })[0]!;
    expect(result.value).toBe('credits'); expect(result.leftPercent).toBe(0);
    expect(result.summary).toContain('Credits available');
    expect(result.detail).toContain('2048.4196250000 credits available');
    expect(result.detail.some((line) => line.includes('Estimated credit value $81.94'))).toBe(true);
    expect(result.detail.some((line) => line.includes('autonomous credit spending is not admitted'))).toBe(true);
  });
  it('reports a vendor spend-control hold separately from its remaining balance', () => {
    const result = barRows([row({ engine: 'codex', credits: '12 credits available', creditSpendControlReached: true,
      windows: [win({ usedPercent: 100 })] })], { healthRead: true, now: NOW })[0]!;
    expect(result.value).toBe('credits held'); expect(result.summary).toContain('Credits held');
    expect(result.detail).toContain('12 credits available'); expect(result.leftPercent).toBe(0);
  });
  it('never publishes stale or signed-out credits as currently available', () => {
    for (const patch of [{ signedOut: true }, { lastReading: true }]) {
      expect(barRows([row({ engine: 'codex', credits: '12 credits available', ...patch })], { healthRead: true, now: NOW })[0]!.value).not.toBe('credits');
    }
  });
});
