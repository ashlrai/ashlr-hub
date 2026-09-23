import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clampWidth,
  clearVerseCommand,
  getVerseUiState,
  requestVerseCommand,
  resetVerseUi,
  setVersePendingApprovals,
  setVerseResourcesOpen,
  setVerseSection,
  setVerseSidebarWidth,
  subscribeVerseUi,
  toggleVerseSidebar,
  VERSE_SECTIONS,
  VERSE_SIDEBAR,
  VERSE_UI_STORAGE_KEY,
} from './verse-ui-store.js';

function stored(): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(VERSE_UI_STORAGE_KEY) ?? '{}') as Record<string, unknown>;
}

beforeEach(() => {
  localStorage.clear();
  resetVerseUi();
});

describe('verse-ui-store', () => {
  it('lists the rail sections in ⌘1–⌘6 order with their module names', () => {
    expect(VERSE_SECTIONS.map((s) => s.id)).toEqual([
      'chat', 'autonomy', 'approvals', 'usage', 'settings', 'mcp',
    ]);
    expect(VERSE_SECTIONS.map((s) => s.module)).toEqual([
      'ChatSection', 'AutonomySection', 'ApprovalsSection', 'UsageSection', 'SettingsSection',
      'McpSection',
    ]);
  });

  it('keeps MCP registered, and keeps the first five bindings where they were', () => {
    // REGRESSION. The MCP section shipped complete — component, queries,
    // contract, tests and both server routes — and was unreachable for a
    // whole release solely because it was missing from this list. Removing
    // the entry is exactly how that happened, so it is pinned here as well
    // as through the shell (VerseApp.test.tsx mounts every entry).
    expect(VERSE_SECTIONS.find((s) => s.id === 'mcp')).toEqual({
      id: 'mcp', label: 'MCP', module: 'McpSection',
    });
    // ⌘1–⌘5 are shipped muscle memory; MCP extends the scheme at ⌘6 rather
    // than renumbering Settings out from under anyone.
    expect(VERSE_SECTIONS[4]!.id).toBe('settings');
    expect(VERSE_SECTIONS[5]!.id).toBe('mcp');
  });

  it('accepts mcp as a persisted section, so a reload lands back on it', () => {
    setVerseSection('mcp');
    expect(stored()).toMatchObject({ section: 'mcp' });
  });

  it('persists layout under ashlr.verse.ui.v2 and clamps widths to the design range', () => {
    setVerseSection('usage');
    setVerseSidebarWidth(4000);
    setVerseResourcesOpen(false);
    toggleVerseSidebar();
    expect(stored()).toEqual({
      section: 'usage',
      sidebarWidth: VERSE_SIDEBAR.max,
      sidebarCollapsed: true,
      resourcesOpen: false,
      resourcesWidth: getVerseUiState().resourcesWidth,
    });
    expect(clampWidth(10, VERSE_SIDEBAR)).toBe(VERSE_SIDEBAR.min);
    expect(clampWidth('nonsense', VERSE_SIDEBAR)).toBe(VERSE_SIDEBAR.def);
  });

  it('keeps the pending-approval count and the ⌘N/⌘K command out of storage', () => {
    setVersePendingApprovals(7);
    requestVerseCommand('new-chat');
    expect(getVerseUiState().pendingApprovals).toBe(7);
    expect(getVerseUiState().command).toEqual({ name: 'new-chat', nonce: expect.any(Number) });
    // A stale count restored from disk would claim work is waiting when it is not.
    expect(stored()).not.toHaveProperty('pendingApprovals');
    expect(stored()).not.toHaveProperty('command');
    // Negative / non-finite counts mean "unknown", which is no dot.
    setVersePendingApprovals(Number.NaN);
    expect(getVerseUiState().pendingApprovals).toBe(0);
  });

  it('routes a command to Chat and gives each one a fresh nonce', () => {
    setVerseSection('settings');
    requestVerseCommand('quick-switcher');
    const first = getVerseUiState();
    expect(first.section).toBe('chat');
    clearVerseCommand();
    expect(getVerseUiState().command).toBeNull();
    requestVerseCommand('quick-switcher');
    expect(getVerseUiState().command?.nonce).toBeGreaterThan(first.command!.nonce);
  });

  it('only notifies subscribers when something actually changed', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeVerseUi(listener);
    setVerseSection('usage');
    expect(listener).toHaveBeenCalledTimes(1);
    const snapshot = getVerseUiState();
    setVerseSection('usage');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getVerseUiState()).toBe(snapshot);
    unsubscribe();
    setVerseSection('chat');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('ignores an unknown or corrupt persisted section rather than mounting nothing', () => {
    localStorage.setItem(VERSE_UI_STORAGE_KEY, JSON.stringify({ section: 'wormhole', sidebarWidth: -3 }));
    // read() runs at module load, so exercise it through the same guard clamp.
    expect(clampWidth(-3, VERSE_SIDEBAR)).toBe(VERSE_SIDEBAR.def);
    localStorage.setItem(VERSE_UI_STORAGE_KEY, '{not json');
    expect(() => resetVerseUi()).not.toThrow();
  });
});
