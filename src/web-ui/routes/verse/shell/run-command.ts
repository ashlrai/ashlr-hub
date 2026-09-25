/**
 * routes/verse/shell/run-command.ts — "run catalog command X" from anywhere:
 * a key, the palette, the native menu, a button (unit C1).
 *
 *   - guarded commands (Stop running chats…, Stop the fleet…) go through
 *     confirm → token → run (guarded-action.tsx), with the runner defined
 *     by the SHELL (guarded-runners.ts, loaded when a run is confirmed):
 *     they are shell actions, and a guard must never depend on some other
 *     unit remembering to confirm;
 *   - chat commands run on the chat's handler, and when Chat is not on
 *     screen the shell switches to it and parks the command until the chat
 *     registers (command-bus runCommandWhenReady);
 *   - the composer's commands (`composer.*`, C3) are answered by the Composer
 *     through the `ashlr:command` window event, not the bus — so they are
 *     DISPATCHED to it, after switching to Chat and waiting for a composer to
 *     exist (deliverComposerCommand);
 *   - everything else runs on its registered handler.
 *
 * Palette-listed commands are remembered for the empty-query "Recent" list.
 */
import { useEffect } from 'react';
import { useToast } from '../../../components/primitives/Toast.js';
import { cycleTheme } from '../../../data/theme-store.js';
import {
  closeVerseOverlay,
  cycleVerseRecentChat,
  getVerseUiState,
  openVerseNeedsYou,
  recordVerseAction,
  requestVerseCommand,
  setVerseSection,
  stepVerseHistory,
  toggleVerseOverlay,
  toggleVerseRail,
  type VerseSectionId,
} from '../verse-ui-store.js';
import { COMPOSER_COMMAND_IDS, WORKBENCH_COMMAND_EVENT } from '../composer/composer-keys.js';
import { PARKED_COMMAND_TTL_MS, registerCommandHandler, runCommand, runCommandWhenReady, type CommandInvocation } from './command-bus.js';
import { findCommand } from './command-catalog.js';
import { requestGuarded } from './guarded-action.js';

export type ShellNotify = (message: string, tone?: 'neutral' | 'success' | 'danger') => void;

let notify: ShellNotify = () => {};

/** The shell installs its toast here (run-command has no React context). */
export function setShellNotifier(fn: ShellNotify | null): void {
  notify = fn ?? (() => {});
}

/** Toast through whatever the shell installed (guarded-runners.ts reports with it). */
export function shellNotify(message: string, tone?: 'neutral' | 'success' | 'danger'): void {
  notify(message, tone);
}

/**
 * The guarded catalog commands the shell runs itself. Their runners
 * (guarded-runners.ts: a cancel per running chat, the fleet stop and its
 * toast) are a dynamic import — they run only after the operator confirmed
 * (and unlocked), never at first paint, so they stay out of the chat
 * first-paint critical JS. guarded-runners.test.ts pins that this list and
 * the runner table name the same ids.
 */
export const SHELL_GUARDED_COMMAND_IDS: ReadonlySet<string> = new Set(['chats.stop-all', 'fleet.stop']);

/** The composer's message box inside the Chat surface (C3's Composer names it "Message"). */
function composerPresent(): boolean {
  return document.querySelector('[data-surface="chat"] textarea[aria-label="Message"]') !== null;
}

function dispatchComposerCommand(id: string): void {
  window.dispatchEvent(new CustomEvent(WORKBENCH_COMMAND_EVENT, { detail: { id } }));
}

/**
 * How long after the composer's box appears before the command is sent. The
 * box is in the DOM at React's commit; the Composer's window listener is a
 * passive effect that runs a moment LATER. Firing on the mutation itself can
 * beat the listener and the command vanishes, so the dispatch waits a beat.
 */
export const COMPOSER_LISTEN_GRACE_MS = 50;

/**
 * Run a `composer.*` command on the Composer. With a composer already mounted
 * (even behind another surface: keep-alive leaves its listener live) it goes
 * now. Otherwise Chat is opened and the command waits — within the same TTL
 * as a parked bus command — for a composer to mount. A command that finds no
 * composer in time is dropped: running it 20 s later would be a surprise.
 */
export function deliverComposerCommand(id: string, ttlMs: number = PARKED_COMMAND_TTL_MS): void {
  if (typeof document === 'undefined') return;
  if (getVerseUiState().section !== 'chat') setVerseSection('chat');
  if (composerPresent()) {
    dispatchComposerCommand(id);
    return;
  }
  let done = false;
  const finish = (found: boolean) => {
    if (done) return;
    done = true;
    observer.disconnect();
    window.clearTimeout(expiry);
    if (found) window.setTimeout(() => dispatchComposerCommand(id), COMPOSER_LISTEN_GRACE_MS);
  };
  const observer = new MutationObserver(() => {
    if (composerPresent()) finish(true);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  const expiry = window.setTimeout(() => finish(false), ttlMs);
}

const COMPOSER_IDS: ReadonlySet<string> = new Set(COMPOSER_COMMAND_IDS);

/** Run catalog command `id`. Returns false when nothing could run it. */
export function executeCatalogCommand(id: string, invocation: CommandInvocation = {}): boolean {
  const command = findCommand(id);
  if (!command) return false;
  if (command.group !== null && invocation.via === 'palette') recordVerseAction(command.id);

  if (command.guard) {
    if (!SHELL_GUARDED_COMMAND_IDS.has(command.id)) return runCommand(id, invocation);
    const commandId = command.id;
    const { confirm, token } = command.guard;
    requestGuarded({
      title: confirm.title,
      body: confirm.body,
      confirmLabel: confirm.confirmLabel,
      destructive: confirm.destructive,
      token,
      tokenReason: `${command.title.replace(/…$/, '')} requires the dispatch token.`,
      run: () => import('./guarded-runners.js').then((m) => m.runGuardedShellCommand(commandId)),
    });
    return true;
  }

  if (COMPOSER_IDS.has(command.id)) {
    // A bus handler (should C3 ever register one) outranks the event.
    if (runCommand(id, invocation)) return true;
    deliverComposerCommand(id);
    return true;
  }

  if (command.scope === 'chat' || command.scope === 'composer') {
    if (runCommand(id, invocation)) return true;
    // Explicitly asked for a chat action: going to Chat is the point.
    if (getVerseUiState().section !== 'chat') setVerseSection('chat');
    runCommandWhenReady(id, invocation);
    return true;
  }

  if (runCommand(id, invocation)) return true;
  notify(`${command.title} isn't available here yet.`, 'neutral');
  return false;
}

/**
 * The GLOBAL commands the shell itself serves (every other id belongs to the
 * unit that owns the behaviour). Returns the unregister function.
 */
export function registerShellCommandHandlers(): () => void {
  const surfaces: Array<[string, VerseSectionId]> = [
    ['surface.command', 'command'],
    ['surface.fleet', 'fleet'],
    ['surface.growth', 'growth'],
    ['surface.mind', 'mind'],
    ['surface.chat', 'chat'],
    ['section.settings', 'settings'],
    ['section.apps', 'apps'],
    ['section.usage', 'usage'],
  ];
  const offs = [
    ...surfaces.map(([id, section]) => registerCommandHandler(id, () => setVerseSection(section))),
    registerCommandHandler('palette.open', () => toggleVerseOverlay('palette')),
    registerCommandHandler('needs-you.open', (inv) => {
      // The menu / a notification OPENS it; the key toggles.
      if (inv.via !== 'menu' && getVerseUiState().overlay === 'needs-you') closeVerseOverlay();
      else openVerseNeedsYou();
    }),
    registerCommandHandler('shortcuts.open', () => toggleVerseOverlay('shortcuts')),
    registerCommandHandler('history.back', () => { stepVerseHistory(-1); }),
    registerCommandHandler('history.forward', () => { stepVerseHistory(1); }),
    registerCommandHandler('chat.recent-next', () => { cycleVerseRecentChat(1); }),
    registerCommandHandler('chat.recent-prev', () => { cycleVerseRecentChat(-1); }),
    registerCommandHandler('rail.toggle-labels', () => toggleVerseRail()),
    registerCommandHandler('chat.new', () => requestVerseCommand('new-chat')),
    registerCommandHandler('chat.new-on', (inv) => {
      const seat = inv.argument?.kind === 'seat' ? inv.argument.id : undefined;
      requestVerseCommand('new-chat', seat ? { seatId: seat } : {});
    }),
    registerCommandHandler('appearance.toggle-theme', () => cycleTheme()),
    registerCommandHandler('app.summon', () => requestVerseCommand('focus-composer')),
  ];
  return () => offs.forEach((off) => off());
}

/** Mounted once by the shell: the global handlers, and toasts for run-command. */
export function useShellCommands(): void {
  const toast = useToast();
  useEffect(() => {
    setShellNotifier(toast.show);
    return () => setShellNotifier(null);
  }, [toast.show]);
  useEffect(() => registerShellCommandHandlers(), []);
}
