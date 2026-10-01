import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getSidebarCollapse, resetSidebarCollapse, SAVED_PROJECTS_GROUP, setSidebarGroupCollapsed, SIDEBAR_COLLAPSE_KEY } from './sidebar-collapse-pref.js';

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.removeItem(SIDEBAR_COLLAPSE_KEY);
  resetSidebarCollapse();
});

describe('sidebar collapse display preferences', () => {
  it('preserves independent groups across storage reload without changing unrelated UI preferences', () => {
    localStorage.setItem('ashlr.verse.drafts.v1', 'keep');
    setSidebarGroupCollapsed('project:/demo/one', true);
    setSidebarGroupCollapsed('project:/demo/two', true);
    setSidebarGroupCollapsed(SAVED_PROJECTS_GROUP, true);
    setSidebarGroupCollapsed('project:/demo/one', false);
    resetSidebarCollapse();
    expect([...getSidebarCollapse()]).toEqual(['project:/demo/two', SAVED_PROJECTS_GROUP]);
    expect(localStorage.getItem('ashlr.verse.drafts.v1')).toBe('keep');
  });

  it.each(['{broken', '{}', '["archived"]', '[null]', ' '.repeat(65537)])('fails safely on malformed or oversized stored choices', (raw) => {
    localStorage.setItem(SIDEBAR_COLLAPSE_KEY, raw);
    expect(getSidebarCollapse().size).toBe(0);
  });

  it('retains more than 64 independent project choices without a roster count cap', () => {
    for (let i = 0; i < 150; i++) setSidebarGroupCollapsed(`project:/demo/${i}`, true);
    resetSidebarCollapse();
    expect(getSidebarCollapse().size).toBe(150);
  });

  it('keeps choices for the page when browser storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    setSidebarGroupCollapsed('project:/demo/one', true);
    expect(getSidebarCollapse().has('project:/demo/one')).toBe(true);
  });
});
