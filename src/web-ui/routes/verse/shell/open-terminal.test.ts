/**
 * shell/open-terminal.ts + open-terminal-request.ts — every pointer at a
 * terminal tab (notification click, ?terminal= link, verse://terminal link, a
 * Needs-you row) lands on that tab in ITS chat, with the Terminal pane asked
 * to focus it (and show the block) — after the chat switch, never before it
 * (the chat surface drops pane requests on a switch). A tab that is gone is
 * said so, not opened.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerseTerminalListResponse, VerseTerminalTab } from '../../../data/api-types.js';
import { activateDockChat, clearDockRequests, getDockSnapshot, resetDockStore } from '../dock/dock-store.js';
import { getVerseUiState, openVerseNeedsYou, resetVerseUi, setVerseActiveSession } from '../verse-ui-store.js';
import { openTerminalTarget, SWITCH_WAIT_MS, TERMINAL_GONE_MESSAGE } from './open-terminal.js';
import {
  normalizeOpenTerminalRequest,
  requestOpenTerminal,
  subscribeOpenTerminal,
  VERSE_OPEN_TERMINAL_EVENT,
} from './open-terminal-request.js';

function tab(id: string, sessionId: string | null): VerseTerminalTab {
  return {
    id,
    sessionId,
    root: '/tmp/repo',
    title: 'repo',
    cols: 80,
    rows: 24,
    createdAt: '2026-09-27T10:00:00.000Z',
    lastActivityAt: '2026-09-27T10:00:00.000Z',
    exited: null,
    appId: null,
    devServerId: null,
  };
}

const listing = (...tabs: VerseTerminalTab[]): (() => Promise<VerseTerminalListResponse>) =>
  async () => ({ available: true, reason: null, tabs });

beforeEach(() => {
  localStorage.clear();
  resetVerseUi();
  resetDockStore();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the request channel', () => {
  it('cleans requests and drops anything that is not a terminal tab', () => {
    expect(normalizeOpenTerminalRequest({ tabId: 't-ab12', blockId: 'b-7' })).toEqual({ tabId: 't-ab12', blockId: 'b-7', sessionId: null });
    expect(normalizeOpenTerminalRequest({ tabId: 't-ab12', blockId: 'b-x', sessionId: 'vs_1' })).toEqual({ tabId: 't-ab12', blockId: null, sessionId: 'vs_1' });
    expect(normalizeOpenTerminalRequest({ tabId: 't-ab12', blockId: null, sessionId: 'a b' })).toEqual({ tabId: 't-ab12', blockId: null, sessionId: null });
    for (const bad of [null, 'x', {}, { tabId: 'T-1' }, { tabId: 't-' }, { tabId: '../t-1' }, { tabId: `t-${'a'.repeat(33)}` }]) {
      expect(normalizeOpenTerminalRequest(bad)).toBeNull();
    }
  });

  it('delivers a clean request to the subscriber, and nothing for a malformed event', () => {
    const seen = vi.fn();
    const off = subscribeOpenTerminal(seen);
    requestOpenTerminal({ tabId: 't-1', blockId: 'b-2', sessionId: 'vs_1' });
    window.dispatchEvent(new CustomEvent(VERSE_OPEN_TERMINAL_EVENT, { detail: { tabId: 'nope' } }));
    off();
    requestOpenTerminal({ tabId: 't-1', blockId: null });
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith({ tabId: 't-1', blockId: 'b-2', sessionId: 'vs_1' });
  });
});

describe('openTerminalTarget', () => {
  it('says so when the tab is gone, and opens nothing', async () => {
    const toast = vi.fn();
    expect(await openTerminalTarget({ tabId: 't-gone', blockId: null }, { toast, list: listing(tab('t-other', 'vs_1')) })).toBe(false);
    expect(toast).toHaveBeenCalledWith(TERMINAL_GONE_MESSAGE, 'neutral');
    expect(getDockSnapshot().requests.terminal).toBeNull();
  });

  it('names the reason when this server has no terminal at all', async () => {
    const toast = vi.fn();
    const list = async (): Promise<VerseTerminalListResponse> => ({ available: false, reason: 'No PTY in this build.', tabs: [] });
    expect(await openTerminalTarget({ tabId: 't-1', blockId: null }, { toast, list })).toBe(false);
    expect(toast).toHaveBeenCalledWith('No PTY in this build.', 'neutral');
  });

  it('opens the tab’s own chat (the server’s answer beats the caller’s guess) and asks the pane for the tab and block', async () => {
    vi.useFakeTimers();
    openVerseNeedsYou();
    const toast = vi.fn();
    const opened = await openTerminalTarget({ tabId: 't-a1', blockId: 'b-3', sessionId: 'vs_stale' }, { toast, list: listing(tab('t-a1', 'vs_real')) });
    expect(opened).toBe(true);
    expect(toast).not.toHaveBeenCalled();
    expect(getVerseUiState().overlay).toBeNull();
    expect(getVerseUiState().activeSessionId).toBe('vs_real');
    // No chat surface reported a switch here (none is rendered): the fallback raises it.
    await vi.advanceTimersByTimeAsync(SWITCH_WAIT_MS + 1);
    expect(getDockSnapshot().requests.terminal).toMatchObject({ tabId: 't-a1', blockId: 'b-3' });
    expect(getDockSnapshot().state).toMatchObject({ open: true, active: 'terminal' });
  });

  it('with a chat on screen, waits for the switch so the chat surface cannot drop the request', async () => {
    vi.useFakeTimers();
    activateDockChat('vs_old');
    setVerseActiveSession('vs_old');
    expect(getVerseUiState().mounted).toContain('chat');

    await openTerminalTarget({ tabId: 't-b2', blockId: null }, { toast: vi.fn(), list: listing(tab('t-b2', 'vs_new')) });
    expect(getDockSnapshot().requests.terminal).toBeNull(); // not before the switch

    // What ChatSection does on a switch, in one effect: the layout swap, then the drop.
    activateDockChat('vs_new');
    clearDockRequests();
    await vi.advanceTimersByTimeAsync(0);
    expect(getDockSnapshot().requests.terminal).toMatchObject({ tabId: 't-b2' });
    expect(getDockSnapshot().requests.terminal?.blockId).toBeUndefined();
  });

  it('raises the request anyway if the switch never reports', async () => {
    vi.useFakeTimers();
    activateDockChat('vs_old');
    setVerseActiveSession('vs_old');
    await openTerminalTarget({ tabId: 't-c3', blockId: 'b-1' }, { toast: vi.fn(), list: listing(tab('t-c3', 'vs_new')) });
    expect(getDockSnapshot().requests.terminal).toBeNull();
    await vi.advanceTimersByTimeAsync(SWITCH_WAIT_MS + 1);
    expect(getDockSnapshot().requests.terminal).toMatchObject({ tabId: 't-c3', blockId: 'b-1' });
  });

  it('requests at once when the tab’s chat is already the open one', async () => {
    activateDockChat('vs_1');
    setVerseActiveSession('vs_1');
    await openTerminalTarget({ tabId: 't-d4', blockId: null }, { toast: vi.fn(), list: listing(tab('t-d4', 'vs_1')) });
    expect(getDockSnapshot().requests.terminal).toMatchObject({ tabId: 't-d4' });
  });

  it('a tab with no chat opens on the Chat surface; an unreachable server falls back to the caller’s chat', async () => {
    await openTerminalTarget({ tabId: 't-e5', blockId: null }, { toast: vi.fn(), list: listing(tab('t-e5', null)) });
    expect(getVerseUiState().section).toBe('chat');
    expect(getDockSnapshot().requests.terminal).toMatchObject({ tabId: 't-e5' });

    resetVerseUi();
    resetDockStore();
    const down = async (): Promise<VerseTerminalListResponse> => { throw new Error('offline'); };
    expect(await openTerminalTarget({ tabId: 't-f6', blockId: null, sessionId: 'vs_hint' }, { toast: vi.fn(), list: down })).toBe(true);
    expect(getVerseUiState().activeSessionId).toBe('vs_hint');
  });

  it('refuses a malformed request without asking the server', async () => {
    const list = vi.fn(listing());
    expect(await openTerminalTarget({ tabId: 'x', blockId: null }, { toast: vi.fn(), list })).toBe(false);
    expect(list).not.toHaveBeenCalled();
  });
});
