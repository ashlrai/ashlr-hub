/**
 * 3.15 — ⌘K "Generate command…" and "Search terminal history…" are served by
 * the terminal's pane registration (after first paint), not by ChatSection:
 * each goes to Chat and asks the Terminal panel for its prompt. Nothing runs.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { getDockSnapshot, resetDockStore } from '../dock/dock-store.js';
import { runCommand } from '../shell/command-bus.js';
import { getVerseUiState, setVerseSection } from '../verse-ui-store.js';
import './terminal.pane.js';

afterEach(() => resetDockStore());

describe('the terminal\'s ⌘K commands', () => {
  it('Generate command… opens the terminal on Chat with an assist request', () => {
    setVerseSection('fleet');
    expect(runCommand('terminal.generate')).toBe(true);
    expect(getVerseUiState().section).toBe('chat');
    const snap = getDockSnapshot();
    expect(snap.requests.terminal).toMatchObject({ assist: true });
    expect(snap.state.open).toBe(true);
  });

  it('Search terminal history… asks for the history palette', () => {
    expect(runCommand('terminal.history')).toBe(true);
    expect(getDockSnapshot().requests.terminal).toMatchObject({ history: true });
  });
});
