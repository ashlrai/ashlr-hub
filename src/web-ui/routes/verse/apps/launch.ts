/**
 * routes/verse/apps/launch.ts — where a [Launch ▸] goes.
 *
 * Two homes for the agent's terminal:
 *   - INSIDE Verse: a tab in the chat dock's Terminal (C4's pane, C2's dock),
 *     in the folder of the chat you have open. Needs the desktop app (the
 *     sidecar's Bun PTY — GET /api/verse/terminal says `available`), the
 *     Terminal pane to have landed in this build, and an open chat to host it.
 *   - Terminal.app: POST /api/verse/apps/:id/launch, in the folder you chose.
 *     Works from a plain browser too (macOS).
 *
 * In-Verse launch rides the dock's own one-shot request (dock-store.ts
 * `requestTerminal`): `{ appId }`, plus `{ via, model }` for an Ollama launch
 * (the contract fields on VerseTerminalCreateRequest). The server resolves
 * the command itself — the catalog's own argv, or `ollama launch <id>
 * [--model <tag>]` through the same `resolveAppLaunch` Apps' Terminal.app
 * launch uses, which refuses an agent that is not installed, an Ollama that
 * does not list it, or a tag it does not have — and RUNS it in the new tab.
 * Nothing typed comes from the page; the dialog shows that exact command
 * before the click. (Until 3.10.1 a model launch was only pasted, because
 * the request had no model field.)
 */
import { shellCommandText } from '../health/health-model.js';
import { requestTerminal } from '../dock/dock-store.js';
import { isSlotAvailable } from '../shell/slots.js';
import { setVerseSection } from '../verse-ui-store.js';
import type { LaunchChoice } from './apps-model.js';

/** An argv as the operator would type it (the same quoting the health banner uses). */
export const commandText = shellCommandText;

export interface InVerseAvailability {
  available: boolean;
  /** Why not, in operator language; null when available. */
  reason: string | null;
}

export function inVerseAvailability(input: {
  terminalAvailable: boolean | null;
  terminalReason: string | null;
  activeSessionId: string | null;
  slotLanded?: boolean;
}): InVerseAvailability {
  const landed = input.slotLanded ?? isSlotAvailable('terminal-pane');
  if (!landed) return { available: false, reason: 'This build has no Verse terminal yet.' };
  if (input.terminalAvailable !== true) {
    return { available: false, reason: input.terminalReason ?? 'The Verse terminal needs the desktop app.' };
  }
  if (input.activeSessionId === null) return { available: false, reason: 'Open a chat first — its terminal hosts the agent.' };
  return { available: true, reason: null };
}

/** Open the agent in a new dock terminal tab and bring Chat forward. */
export function launchInVerse(appId: string, choice: LaunchChoice): void {
  if (choice.via === 'native' && choice.model === null) {
    requestTerminal({ newTab: true, appId });
  } else {
    // A model is an Ollama tag: it only ever launches through Ollama.
    requestTerminal({ newTab: true, appId, via: 'ollama', ...(choice.model !== null ? { model: choice.model } : {}) });
  }
  // The request waits in the dock store until Chat serves it (ChatSection
  // clears requests only on a chat SWITCH, not on its first mount).
  setVerseSection('chat');
}
