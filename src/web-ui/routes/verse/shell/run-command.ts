/**
 * routes/verse/shell/run-command.ts — "run catalog command X" from anywhere:
 * a key, the palette, the native menu, a button (unit C1).
 *
 *   - guarded commands (Stop running chats…, Stop the fleet…) go through
 *     confirm → token → run (guarded-action.tsx), with the runner defined
 *     HERE: they are shell actions, and a guard must never depend on some
 *     other unit remembering to confirm;
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
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { ApiError, apiPost } from '../../../data/client.js';
import { cycleTheme } from '../../../data/theme-store.js';
import { cancelVerseTurn } from '../verse-queries.js';
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
import { getActivityState, refreshActivity } from './useActivity.js';

export type ShellNotify = (message: string, tone?: 'neutral' | 'success' | 'danger') => void;

let notify: ShellNotify = () => {};

/** The shell installs its toast here (run-command has no React context). */
export function setShellNotifier(fn: ShellNotify | null): void {
  notify = fn ?? (() => {});
}

function requireToken(path: string): string {
  const token = getMutationToken();
  if (!token) throw new ApiError('Mutation token was rejected.', 401, path);
  return token;
}

/** Stop every running chat. Stops what activity says is running NOW, one cancel each. */
async function stopRunningChats(): Promise<void> {
  await refreshActivity();
  const running = getActivityState().data?.running ?? [];
  if (running.length === 0) {
    notify('Nothing is running.', 'neutral');
    return;
  }
  requireToken('/api/verse/sessions');
  const results = await Promise.allSettled(running.map((r) => cancelVerseTurn(r.sessionId)));
  touchMutationHold();
  const failed = results.filter((r) => r.status === 'rejected').length;
  void refreshActivity();
  if (failed > 0) throw new Error(`Stopped ${running.length - failed} of ${running.length} chats; ${failed} did not answer.`);
  notify(running.length === 1 ? 'Stopped 1 chat.' : `Stopped ${running.length} chats.`, 'success');
}

/**
 * Stop the fleet: the authority route's `stop` (B-U1) when this build has it;
 * otherwise the daemon's ordinary stop, which engages the kill switch
 * (control-api.ts `POST /api/verse/daemon {action:'stop'}`). Both stop
 * autonomous work only — chats keep running.
 */
async function stopFleet(): Promise<void> {
  const token = requireToken('/api/verse/authority');
  let body: unknown = null;
  try {
    body = await apiPost<unknown>('/api/verse/authority', { action: 'stop' }, token);
  } catch (err) {
    // A CODELESS 404 from the authority route = not in this build (or no
    // dispatch, which the daemon route will then report on its own).
    if (!(err instanceof ApiError && err.status === 404 && err.code === null)) throw err;
    await apiPost<unknown>('/api/verse/daemon', { action: 'stop' }, token);
  }
  touchMutationHold();
  void refreshActivity();
  notify(describeFleetStop(body), 'success');
}

/**
 * The toast after Stop, from B-U1's StopResult (`{ result: { stop } }` on
 * the authority route). Stop arms KILL at once but does not wait for agents
 * admitted before it (waitMs 0), so "stopped" alone would claim more than the
 * server knows (B-U6 request 8): the drain state and any armed merge it could
 * not revoke are said out loud. The daemon fallback has no such fields and
 * gets the plain sentence.
 */
export function describeFleetStop(body: unknown): string {
  const base = 'Fleet stopped. It stays stopped until you resume it.';
  const stop = (body as { result?: { stop?: unknown } } | null)?.result?.stop;
  if (typeof stop !== 'object' || stop === null) return base;
  const { quiesced, liveExecutionLeases, mergeRevokeFailures } = stop as {
    quiesced?: unknown;
    liveExecutionLeases?: unknown;
    mergeRevokeFailures?: unknown;
  };
  const parts = [base];
  if (quiesced === false) {
    const n = typeof liveExecutionLeases === 'number' && Number.isFinite(liveExecutionLeases) && liveExecutionLeases > 0 ? liveExecutionLeases : null;
    // Unknown counts as still running (the server fails closed the same way).
    parts.push(n === null ? 'Agents already running are finishing.' : `${n} agent${n === 1 ? ' is' : 's are'} still finishing work started before Stop.`);
  }
  if (Array.isArray(mergeRevokeFailures) && mergeRevokeFailures.length > 0) {
    const m = mergeRevokeFailures.length;
    parts.push(`${m} armed merge${m === 1 ? '' : 's'} could not be revoked; Stop still blocks ${m === 1 ? 'it' : 'them'}.`);
  }
  return parts.join(' ');
}

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

const GUARDED_RUNNERS: Readonly<Record<string, () => Promise<void>>> = {
  'chats.stop-all': stopRunningChats,
  'fleet.stop': stopFleet,
};

/** Run catalog command `id`. Returns false when nothing could run it. */
export function executeCatalogCommand(id: string, invocation: CommandInvocation = {}): boolean {
  const command = findCommand(id);
  if (!command) return false;
  if (command.group !== null && invocation.via === 'palette') recordVerseAction(command.id);

  if (command.guard) {
    const runner = GUARDED_RUNNERS[command.id];
    if (!runner) return runCommand(id, invocation);
    const { confirm, token } = command.guard;
    requestGuarded({
      title: confirm.title,
      body: confirm.body,
      confirmLabel: confirm.confirmLabel,
      destructive: confirm.destructive,
      token,
      tokenReason: `${command.title.replace(/…$/, '')} requires the dispatch token.`,
      run: runner,
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
