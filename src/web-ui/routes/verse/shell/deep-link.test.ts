/**
 * shell/deep-link.test.ts — links into the workbench (?chat=…&pane=…, and
 * the desktop's `open-pane:` command): parsed strictly, consumed once, and
 * the pane lands in the chat it names — not the one being left.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { activateDockChat, getDockState, openPaneInChat, resetDockStore } from '../dock/dock-store.js';
import { parseDesktopCommand } from './command-keys.js';
import { consumeDeepLink, deepLinkUrl, hasDeepLink, parseDeepLink, parseTerminalLink, terminalLinkUrl } from './deep-link.js';

describe('parseDeepLink', () => {
  it('reads a chat, a pane, or both — and renames a legacy pane id', () => {
    expect(parseDeepLink('?chat=s-123&pane=terminal')).toEqual({ sessionId: 's-123', paneId: 'terminal' });
    expect(parseDeepLink('?chat=s-123')).toEqual({ sessionId: 's-123', paneId: null });
    expect(parseDeepLink('?pane=preview')).toEqual({ sessionId: null, paneId: 'browser' });
  });

  it('ignores anything malformed instead of guessing', () => {
    expect(parseDeepLink('')).toBeNull();
    expect(parseDeepLink('?chat=../../etc&pane=Not%20A%20Pane')).toBeNull();
    expect(parseDeepLink('?chat=ok-1&pane=<script>')).toEqual({ sessionId: 'ok-1', paneId: null });
    expect(hasDeepLink('?section=chat')).toBe(false);
    expect(hasDeepLink('?x=1&pane=files')).toBe(true);
  });
});

describe('consumeDeepLink', () => {
  beforeEach(() => { window.history.replaceState(null, '', '/verse/?chat=s-9&pane=diff&keep=1#top'); });
  afterEach(() => { window.history.replaceState(null, '', '/'); });

  it('returns the link once and strips it from the address bar, keeping everything else', () => {
    expect(consumeDeepLink()).toEqual({ sessionId: 's-9', paneId: 'diff' });
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe('/verse/?keep=1#top');
    expect(consumeDeepLink()).toBeNull();
  });
});

describe('deepLinkUrl', () => {
  it('builds a shareable link on the page\'s own origin and path', () => {
    expect(deepLinkUrl({ sessionId: 's-1', paneId: 'reasoning' }, 'http://127.0.0.1:7777/verse/?chat=old#x'))
      .toBe('http://127.0.0.1:7777/verse/?chat=s-1&pane=reasoning');
    expect(deepLinkUrl({ sessionId: 's-1', paneId: null }, 'http://127.0.0.1:7777/verse/')).toBe('http://127.0.0.1:7777/verse/?chat=s-1');
    // A round trip reads back what was written.
    expect(parseDeepLink(new URL(deepLinkUrl({ sessionId: 's-1', paneId: 'files' }, 'http://h/verse/')).search)).toEqual({ sessionId: 's-1', paneId: 'files' });
  });
});

describe('the desktop open-pane command', () => {
  it('parses `open-pane:<id>` and `open-pane:<id>@<session>`, and nothing looser', () => {
    expect(parseDesktopCommand('open-pane:terminal')).toEqual({ kind: 'open-pane', paneId: 'terminal', sessionId: null });
    expect(parseDesktopCommand('open-pane:diff@s-42')).toEqual({ kind: 'open-pane', paneId: 'diff', sessionId: 's-42' });
    expect(parseDesktopCommand('open-pane:Diff')).toBeNull();
    expect(parseDesktopCommand('open-pane:diff@')).toBeNull();
    expect(parseDesktopCommand('open-session:s-42')).toEqual({ kind: 'open-session', sessionId: 's-42' });
  });
});

describe('openPaneInChat', () => {
  beforeEach(() => { localStorage.clear(); resetDockStore(); });

  it('opens at once in the open chat, and otherwise waits for the switch — landing in the named chat\'s layout', () => {
    activateDockChat('chat-a');
    openPaneInChat('files', 'chat-a');
    expect(getDockState()).toMatchObject({ open: true, active: 'files' });

    openPaneInChat('diff', 'chat-b');
    expect(getDockState().active).toBe('files'); // not yet: chat-a is still open
    activateDockChat('chat-b');
    expect(getDockState()).toMatchObject({ open: true, active: 'diff' });
    // chat-a's layout was saved WITHOUT the diff.
    expect(getDockState().byChat['chat-a']).toMatchObject({ active: 'files', tabs: ['files'] });
  });

  it('opens in whatever chat is open when none is named', () => {
    openPaneInChat('sources');
    expect(getDockState()).toMatchObject({ open: true, active: 'sources' });
  });
});

describe('terminal links (3.15)', () => {
  it('reads verse://terminal/<tab>[/<block>] and nothing looser', () => {
    expect(parseTerminalLink('verse://terminal/t-ab12')).toEqual({ tabId: 't-ab12', blockId: null });
    expect(parseTerminalLink('verse://terminal/t-ab12/b-42')).toEqual({ tabId: 't-ab12', blockId: 'b-42' });
    expect(parseTerminalLink('verse://terminal/t-ab12/b-42/')).toEqual({ tabId: 't-ab12', blockId: 'b-42' });
    for (const bad of [
      '',
      'verse://terminal/',
      'verse://terminal/T-AB12',
      'verse://terminal/t-ab12/b-x',
      'verse://terminal/t-ab12/b-1234567890',
      'verse://terminal/t-ab12/b-1/extra',
      'verse://terminal/../t-ab12',
      'VERSE://terminal/t-ab12',
      'verse://chat/t-ab12',
      'https://terminal/t-ab12',
      `verse://terminal/t-${'a'.repeat(33)}`,
    ]) {
      expect(parseTerminalLink(bad), bad).toBeNull();
    }
  });

  it('writes the link a parse reads back, leaving a bad block off and refusing a bad tab', () => {
    expect(terminalLinkUrl('t-ab12')).toBe('verse://terminal/t-ab12');
    expect(terminalLinkUrl('t-ab12', 'b-7')).toBe('verse://terminal/t-ab12/b-7');
    expect(terminalLinkUrl('t-ab12', 'b-nope')).toBe('verse://terminal/t-ab12');
    expect(parseTerminalLink(terminalLinkUrl('t-ab12', 'b-7'))).toEqual({ tabId: 't-ab12', blockId: 'b-7' });
    expect(() => terminalLinkUrl('../x')).toThrow(RangeError);
  });

  it('reads ?terminal=<tab>&block=<block>, keeping the old forms exactly as they were', () => {
    expect(parseDeepLink('?terminal=t-ab12&block=b-3')).toEqual({ sessionId: null, paneId: null, terminal: { tabId: 't-ab12', blockId: 'b-3' } });
    expect(parseDeepLink('?terminal=t-ab12&block=nope')).toEqual({ sessionId: null, paneId: null, terminal: { tabId: 't-ab12', blockId: null } });
    expect(parseDeepLink('?chat=s-1&terminal=t-ab12')).toEqual({ sessionId: 's-1', paneId: null, terminal: { tabId: 't-ab12', blockId: null } });
    expect(parseDeepLink('?terminal=T-1')).toBeNull();
    expect(parseDeepLink('?block=b-3')).toBeNull();
    expect(hasDeepLink('?terminal=t-1')).toBe(true);
    expect(parseDeepLink('?chat=s-123&pane=terminal')).toEqual({ sessionId: 's-123', paneId: 'terminal' });
    expect(new URL(deepLinkUrl({ terminal: { tabId: 't-ab12', blockId: 'b-3' } }, 'http://h/verse/?block=b-1')).search).toBe('?terminal=t-ab12&block=b-3');
  });

  it('consumes a terminal link once, stripping its params and keeping the rest', () => {
    window.history.replaceState(null, '', '/verse/?terminal=t-ab12&block=b-3&keep=1#top');
    try {
      expect(consumeDeepLink()).toEqual({ sessionId: null, paneId: null, terminal: { tabId: 't-ab12', blockId: 'b-3' } });
      expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe('/verse/?keep=1#top');
      expect(consumeDeepLink()).toBeNull();
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });

  it('the desktop sends open-terminal:<tab>[/<block>], and nothing looser parses', () => {
    expect(parseDesktopCommand('open-terminal:t-ab12')).toEqual({ kind: 'open-terminal', tabId: 't-ab12', blockId: null });
    expect(parseDesktopCommand('open-terminal:t-ab12/b-42')).toEqual({ kind: 'open-terminal', tabId: 't-ab12', blockId: 'b-42' });
    for (const bad of [
      'open-terminal:',
      'open-terminal:t-',
      'open-terminal:T-ab12',
      'open-terminal:t-ab12/',
      'open-terminal:t-ab12/b-',
      'open-terminal:t-ab12/b-1234567890',
      'open-terminal:t-ab12/b-1/x',
      'open-terminal:t-ab12@s-1',
      'open-terminal:t-ab12\nopen-needs-you',
      ` open-terminal:t-ab12`,
      `open-terminal:t-${'a'.repeat(33)}`,
    ]) {
      expect(parseDesktopCommand(bad), bad).toBeNull();
    }
  });
});
