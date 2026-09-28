/**
 * routes/verse/playbooks/command-workflow-paste.ts — where a filled command
 * workflow goes from the Playbooks section: the open chat's Terminal pane,
 * PASTED at the prompt through the dock's one-shot request
 * (dock-store.ts `requestTerminal({ paste })`). The Terminal pane types it
 * (bracketed paste; a multi-line command without bracketed paste is copied
 * instead — TerminalLeaf.tsx) and never presses Enter: running it is the
 * operator's keystroke.
 *
 * The terminal panel's own menu mounts CommandWorkflowPicker with its own
 * `onPaste` (straight into the focused tab); this module is only the path
 * from the gear tray.
 */
import { openDockPane, requestTerminal } from '../dock/dock-store.js';
import { isSlotAvailable } from '../shell/slots.js';
import { setVerseSection } from '../verse-ui-store.js';

/** Why a filled command cannot be pasted from here, or null when it can. Pure over its inputs. */
export function commandPasteUnavailableReason(input: { activeSessionId: string | null; terminalLanded?: boolean }): string | null {
  const landed = input.terminalLanded ?? isSlotAvailable('terminal-pane');
  if (!landed) return 'This build has no Verse terminal yet.';
  if (input.activeSessionId === null) return 'Open a chat first — the command is pasted into its terminal.';
  return null;
}

/**
 * Open the chat's Terminal pane and paste `text` at its prompt; bring Chat
 * forward. The request waits in the dock store until the pane serves it
 * (ChatSection clears requests only on a chat SWITCH, not its first mount).
 */
export function pasteIntoChatTerminal(text: string): void {
  // Never a trailing newline: a paste must not submit.
  const paste = text.replace(/[\r\n]+$/, '');
  if (!paste) return;
  openDockPane('terminal');
  requestTerminal({ paste });
  setVerseSection('chat');
}
