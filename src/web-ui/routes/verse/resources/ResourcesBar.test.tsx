/**
 * ResourcesBar — the always-on resource bar (3.11.1): batteries show what is
 * LEFT of each account's binding window, usable accounts lead, spent ones read
 * as empty red batteries, and the bar's on/off choice persists.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { CapacityRow, CapacityWindowRow } from '../usage/capacity-strip-model.js';
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

  it('shows a limit-reached account as an empty battery and sorts it after usable ones', () => {
    const spent = row({ seatId: 'codex-a', label: 'Personal Codex', engine: 'codex', cls: 'blocked', word: 'blocked',
      windows: [win({ id: 'primary', label: 'primary window', limitReached: true, resetText: 'Fri 2:25 PM' })] });
    const rows = barRows([spent, row({})], { healthRead: true, now: NOW });
    expect(rows.map((r) => r.key)).toEqual(['grok-a', 'codex-a']);
    expect(rows[1]!.leftPercent).toBe(0);
    expect(rows[1]!.level).toBe('out');
  });

  it('gives local models a full idle battery and no percentage', () => {
    const local = row({ seatId: 'local', label: 'Local', engine: 'local', kind: 'local', localCount: 3, windows: [], summary: 'ready' });
    const [l] = barRows([local], { healthRead: true, now: NOW });
    expect(l).toMatchObject({ engine: 'local', name: 'Local models (3)', leftPercent: null, level: 'idle', value: 'ready' });
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
