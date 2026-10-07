import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { moveResource, orderedResources, reloadResourceOrderForTest, RESOURCE_ORDER_KEY } from './resource-order.js';

beforeEach(() => { localStorage.removeItem(RESOURCE_ORDER_KEY); reloadResourceOrderForTest(); });
afterEach(() => { vi.restoreAllMocks(); localStorage.removeItem(RESOURCE_ORDER_KEY); reloadResourceOrderForTest(); });

describe('resource layout preferences', () => {
  it('uses stable account IDs and appends new resources without following usage changes', () => {
    const rows = [{ key: 'account:a', percent: 99 }, { key: 'account:b', percent: 0 }, { key: 'budget:devin', percent: 1 }];
    const saved = ['removed', 'account:b', 'account:b', 'account:a'];
    expect(orderedResources(rows, saved).map(row => row.key)).toEqual(['account:b', 'account:a', 'budget:devin']);
    expect(orderedResources(rows.map(row => ({ ...row, percent: 100 - row.percent })), saved).map(row => row.key))
      .toEqual(['account:b', 'account:a', 'budget:devin']);
  });

  it('persists visible moves while retaining temporarily absent accounts', () => {
    localStorage.setItem(RESOURCE_ORDER_KEY, JSON.stringify(['account:a', 'account:absent', 'account:b']));
    reloadResourceOrderForTest();
    expect(moveResource(['account:a', 'account:b'], 'account:b', 'account:a')).toBe(true);
    expect(JSON.parse(localStorage.getItem(RESOURCE_ORDER_KEY)!)).toEqual(['account:b', 'account:a', 'account:absent']);
    expect(moveResource(['account:a', 'account:b'], 'not-here', 'account:a')).toBe(false);
    expect(moveResource(['account:a', 'account:b'], 'account:a', 'account:a')).toBe(false);
  });

  it('keeps moves usable when storage throws and ignores malformed saved layouts', () => {
    localStorage.setItem(RESOURCE_ORDER_KEY, '{broken');
    expect(() => reloadResourceOrderForTest()).not.toThrow();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });
    expect(moveResource(['account:a', 'account:b'], 'account:a', 'account:b')).toBe(true);
  });
});
