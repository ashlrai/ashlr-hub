/**
 * launch.test.ts — where [Launch ▸] goes. Inside Verse only when a terminal
 * can actually host it (the pane landed, the desktop app's PTY is there, a
 * chat is open); the agent's own command is RUN through the dock's `appId`
 * request, and an Ollama launch (with or without a model) the same way plus
 * `via`/`model` — the server builds the command from what is installed, so
 * nothing typed into the shell comes from the page.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const requestTerminal = vi.fn();
const setVerseSection = vi.fn();
vi.mock('../dock/dock-store.js', () => ({ requestTerminal: (...args: unknown[]) => requestTerminal(...args) }));
vi.mock('../verse-ui-store.js', () => ({ setVerseSection: (...args: unknown[]) => setVerseSection(...args) }));

const { inVerseAvailability, launchInVerse } = await import('./launch.js');

beforeEach(() => {
  requestTerminal.mockReset();
  setVerseSection.mockReset();
});

describe('inVerseAvailability', () => {
  it('needs the pane, the desktop app’s terminal, and an open chat — and says which is missing', () => {
    expect(inVerseAvailability({ slotLanded: false, terminalAvailable: true, terminalReason: null, activeSessionId: 's' }))
      .toEqual({ available: false, reason: 'This build has no Verse terminal yet.' });
    expect(inVerseAvailability({ slotLanded: true, terminalAvailable: false, terminalReason: 'Needs the desktop app.', activeSessionId: 's' }))
      .toEqual({ available: false, reason: 'Needs the desktop app.' });
    expect(inVerseAvailability({ slotLanded: true, terminalAvailable: null, terminalReason: null, activeSessionId: 's' }).available).toBe(false);
    expect(inVerseAvailability({ slotLanded: true, terminalAvailable: true, terminalReason: null, activeSessionId: null }))
      .toEqual({ available: false, reason: 'Open a chat first — its terminal hosts the agent.' });
    expect(inVerseAvailability({ slotLanded: true, terminalAvailable: true, terminalReason: null, activeSessionId: 's' }))
      .toEqual({ available: true, reason: null });
  });
});

describe('launchInVerse', () => {
  it('runs the agent’s own command through the catalog appId, in a new tab, and brings Chat forward', () => {
    launchInVerse('codex', { via: 'native', model: null });
    expect(requestTerminal).toHaveBeenCalledWith({ newTab: true, appId: 'codex' });
    expect(setVerseSection).toHaveBeenCalledWith('chat');
  });

  it('an Ollama launch with a model is an appId request with via + model — never a pasted string', () => {
    launchInVerse('claude-code', { via: 'ollama', model: 'qwen3.8:27b' });
    expect(requestTerminal).toHaveBeenCalledWith({ newTab: true, appId: 'claude-code', via: 'ollama', model: 'qwen3.8:27b' });
    expect(requestTerminal.mock.calls[0]![0]).not.toHaveProperty('paste');
  });

  it('an Ollama launch without a model carries no model field', () => {
    launchInVerse('codex', { via: 'ollama', model: null });
    expect(requestTerminal).toHaveBeenCalledWith({ newTab: true, appId: 'codex', via: 'ollama' });
  });
});
