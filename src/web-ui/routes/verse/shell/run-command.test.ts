/**
 * run-command — the composer's commands reach the Composer through the
 * `ashlr:command` window event (C3 cross-unit request), from the palette,
 * the menu or a button, wherever the operator is.
 *
 * Pinned: a mounted composer gets the event at once (and the surface
 * switches to Chat); a composer that mounts later gets it after it can be
 * listening; none in time → dropped, never delivered late; a bus handler, if
 * one is registered, outranks the event; non-composer ids are unaffected.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKBENCH_COMMAND_EVENT } from '../composer/composer-keys.js';
import { getVerseUiState, resetVerseUi, setVerseSection } from '../verse-ui-store.js';
import { registerCommandHandler, resetCommandBus } from './command-bus.js';
import {
  COMPOSER_LISTEN_GRACE_MS,
  executeCatalogCommand,
  registerShellCommandHandlers,
  setShellNotifier,
} from './run-command.js';
import { copyAutonomySetupCommand } from './copy-setup.js';

let received: string[] = [];
const listener = (event: Event) => { received.push(String((event as CustomEvent<{ id: unknown }>).detail.id)); };

function chatSurfaceWithComposer(): HTMLElement {
  const host = document.createElement('div');
  host.setAttribute('data-surface', 'chat');
  const box = document.createElement('textarea');
  box.setAttribute('aria-label', 'Message');
  host.appendChild(box);
  return host;
}

beforeEach(() => {
  received = [];
  localStorage.clear();
  resetVerseUi();
  resetCommandBus();
  window.addEventListener(WORKBENCH_COMMAND_EVENT, listener);
});

afterEach(() => {
  window.removeEventListener(WORKBENCH_COMMAND_EVENT, listener);
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('composer commands', () => {
  it('reach a mounted composer at once, and bring Chat forward', () => {
    document.body.appendChild(chatSurfaceWithComposer());
    setVerseSection('fleet');
    expect(executeCatalogCommand('composer.model', { via: 'palette' })).toBe(true);
    expect(received).toEqual(['composer.model']);
    expect(getVerseUiState().section).toBe('chat');
  });

  it('wait for a composer that mounts later, then give it a beat to start listening', async () => {
    vi.useFakeTimers();
    setVerseSection('growth');
    executeCatalogCommand('composer.effort', { via: 'palette' });
    expect(getVerseUiState().section).toBe('chat');
    expect(received).toEqual([]);
    document.body.appendChild(chatSurfaceWithComposer());
    await vi.advanceTimersByTimeAsync(0); // the MutationObserver callback
    expect(received).toEqual([]);
    await vi.advanceTimersByTimeAsync(COMPOSER_LISTEN_GRACE_MS);
    expect(received).toEqual(['composer.effort']);
  });

  it('are dropped — never delivered late — when no composer appears in time', async () => {
    vi.useFakeTimers();
    executeCatalogCommand('composer.attach', { via: 'palette' });
    await vi.advanceTimersByTimeAsync(5_000);
    document.body.appendChild(chatSurfaceWithComposer());
    await vi.advanceTimersByTimeAsync(COMPOSER_LISTEN_GRACE_MS * 2);
    expect(received).toEqual([]);
  });

  it('go to a bus handler first when one serves the id', () => {
    const handler = vi.fn();
    registerCommandHandler('composer.permission', handler);
    document.body.appendChild(chatSurfaceWithComposer());
    executeCatalogCommand('composer.permission', { via: 'palette' });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(received).toEqual([]);
  });

  it('leave every other command on the bus', () => {
    const handler = vi.fn();
    registerCommandHandler('chat.sidebar', handler);
    executeCatalogCommand('chat.sidebar', { via: 'palette' });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(received).toEqual([]);
  });
});

describe('Command-served commands (autonomy, grant, budget)', () => {
  it('bring Command forward and run on its handler when it is already mounted', () => {
    const handler = vi.fn();
    registerCommandHandler('autonomy.off', handler);
    setVerseSection('chat');
    expect(executeCatalogCommand('autonomy.off', { via: 'palette' })).toBe(true);
    expect(getVerseUiState().section).toBe('command');
    expect(handler).toHaveBeenCalledWith({ via: 'palette' });
  });

  it('park until Command mounts and registers, then run exactly once', async () => {
    setVerseSection('fleet');
    executeCatalogCommand('budget.reserve', { via: 'palette' });
    expect(getVerseUiState().section).toBe('command');
    const handler = vi.fn();
    registerCommandHandler('budget.reserve', handler);
    await Promise.resolve(); // delivery waits a microtask for sibling effects
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('are dropped, never run late, when Command does not register in time', async () => {
    vi.useFakeTimers();
    executeCatalogCommand('autonomy.grant', { via: 'palette' });
    await vi.advanceTimersByTimeAsync(5_000);
    const handler = vi.fn();
    registerCommandHandler('autonomy.grant', handler);
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).not.toHaveBeenCalled();
  });

  it('are remembered for the palette’s Recent list', () => {
    registerCommandHandler('autonomy.propose', () => {});
    executeCatalogCommand('autonomy.propose', { via: 'palette' });
    expect(getVerseUiState().recentActions[0]).toBe('autonomy.propose');
  });
});

describe('Copy autonomy setup command', () => {
  let off: (() => void) | null = null;
  const notify = vi.fn();

  beforeEach(() => {
    notify.mockReset();
    setShellNotifier(notify);
    off = registerShellCommandHandlers();
  });

  afterEach(() => {
    off?.();
    setShellNotifier(null);
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  });

  it('puts `ashlr authority setup` on the clipboard and says what to do with it', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    expect(executeCatalogCommand('autonomy.copy-setup', { via: 'palette' })).toBe(true);
    await vi.waitFor(() => expect(notify).toHaveBeenCalled());
    expect(writeText).toHaveBeenCalledWith('ashlr authority setup');
    expect(notify).toHaveBeenCalledWith('Copied `ashlr authority setup`. Run it in a terminal; add --dry-run to see every step first.', 'success');
    // Stays where the operator is: copying is not a navigation.
    expect(getVerseUiState().section).not.toBe('command');
  });

  it('names the command in the toast when the clipboard refuses', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => { throw new Error('denied'); }) }, configurable: true });
    executeCatalogCommand('autonomy.copy-setup', { via: 'palette' });
    await vi.waitFor(() => expect(notify).toHaveBeenCalled());
    expect(notify).toHaveBeenCalledWith('Could not reach the clipboard. Run `ashlr authority setup` in a terminal.', 'neutral');
  });

  it('says the same when there is no clipboard API at all', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    await expect(copyAutonomySetupCommand()).resolves.toBe(false);
    expect(notify).toHaveBeenCalledWith('Could not reach the clipboard. Run `ashlr authority setup` in a terminal.', 'neutral');
  });
});

describe('Run in cloud…', () => {
  it('reaches the composer through the window event, like the other composer commands', () => {
    document.body.appendChild(chatSurfaceWithComposer());
    setVerseSection('command');
    expect(executeCatalogCommand('composer.cloud', { via: 'palette' })).toBe(true);
    expect(received).toEqual(['composer.cloud']);
    expect(getVerseUiState().section).toBe('chat');
  });
});

describe('the Stop toast', () => {
  it('says what Stop could not promise — agents still draining, merges it could not revoke', async () => {
    const { describeFleetStop } = await import('./guarded-runners.js');
    const plain = 'Fleet stopped. It stays stopped until you resume it.';
    expect(describeFleetStop(null)).toBe(plain);
    expect(describeFleetStop({ result: { stop: { quiesced: true, liveExecutionLeases: 0, mergeRevokeFailures: [] } } })).toBe(plain);
    expect(describeFleetStop({ result: { stop: { quiesced: false, liveExecutionLeases: 2, mergeRevokeFailures: [] } } }))
      .toBe(`${plain} 2 agents are still finishing work started before Stop.`);
    expect(describeFleetStop({ result: { stop: { quiesced: false, liveExecutionLeases: 'x', mergeRevokeFailures: ['m-1'] } } }))
      .toBe(`${plain} Agents already running are finishing. 1 armed merge could not be revoked; Stop still blocks it.`);
  });
});

describe('the shell’s guarded runners (loaded on confirm, not at first paint)', () => {
  it('run-command, guarded-runners and the catalog name the same guarded commands', async () => {
    const { SHELL_GUARDED_COMMAND_IDS } = await import('./run-command.js');
    const { GUARDED_RUNNERS } = await import('./guarded-runners.js');
    const { WORKBENCH_COMMANDS } = await import('./command-catalog.js');
    const guarded = (WORKBENCH_COMMANDS as ReadonlyArray<{ id: string; guard?: unknown }>).filter((c) => c.guard).map((c) => c.id).sort();
    expect([...SHELL_GUARDED_COMMAND_IDS].sort()).toEqual(guarded);
    expect(Object.keys(GUARDED_RUNNERS).sort()).toEqual(guarded);
  });

  it('an unknown id is a rejected run, never a silent success', async () => {
    const { runGuardedShellCommand } = await import('./guarded-runners.js');
    await expect(runGuardedShellCommand('nope')).rejects.toThrow('No shell runner for nope.');
  });
});
