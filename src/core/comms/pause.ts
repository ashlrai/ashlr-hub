/**
 * M212: Soft-pause flag for the comms dispatch cycle.
 *
 * Dual interface:
 *   isPaused() / setPause(on)      — file-existence-based (used by dispatch.ts fast-path)
 *   loadPauseState() / savePauseState(s) — JSON-object-based (used by elon-dialogue, handlers)
 *
 * Both back onto ~/.ashlr/comms/pause.json so state is consistent across callers.
 * The file-existence check for isPaused() reads the same .json file's `paused` field.
 *
 * Never throws.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface PauseState {
  paused: boolean;
  since?: number;
}

function pauseJsonPath(): string {
  return join(homedir(), '.ashlr', 'comms', 'pause.json');
}

export function loadPauseState(): PauseState {
  try {
    if (!existsSync(pauseJsonPath())) return { paused: false };
    const raw = readFileSync(pauseJsonPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<PauseState>;
    return {
      paused: parsed.paused === true,
      since: typeof parsed.since === 'number' ? parsed.since : undefined,
    };
  } catch {
    return { paused: false };
  }
}

export function savePauseState(s: PauseState): void {
  try {
    const dir = join(homedir(), '.ashlr', 'comms');
    mkdirSync(dir, { recursive: true });
    writeFileSync(pauseJsonPath(), JSON.stringify(s, null, 2) + '\n', 'utf8');
  } catch { /* best-effort */ }
}

/** Returns true when the fleet soft-pause flag is active. Never throws. */
export function isPaused(): boolean {
  try { return loadPauseState().paused === true; } catch { return false; }
}

export function setPause(on: boolean): void {
  try {
    if (on) {
      savePauseState({ paused: true, since: Date.now() });
    } else {
      rmSync(pauseJsonPath(), { force: true });
    }
  } catch { /* best-effort */ }
}
