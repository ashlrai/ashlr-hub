/**
 * M32: desktop notifications — macOS only, opt-in, metadata only.
 *
 * Strict no-op unless BOTH hold: process.platform === 'darwin' AND
 * cfg.notify.desktop === true (opt-in mirrors the webhook contract — when
 * unset, nothing fires). Uses `osascript` via execFile (never a shell), with
 * title/body escaped into the AppleScript string literal, a 2s timeout, and a
 * never-throws contract.
 */

import { execFile } from 'node:child_process';
import type { AshlrConfig, NotifyTarget } from '../types.js';

const OSASCRIPT_TIMEOUT_MS = 2_000;

/** Escape a string for inclusion inside an AppleScript double-quoted literal. */
function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
}

/** True when desktop notifications are enabled by config + platform. */
export function desktopNotifyEnabled(cfg: AshlrConfig): boolean {
  if (process.platform !== 'darwin') return false;
  const notify = (cfg as AshlrConfig & { notify?: NotifyTarget }).notify;
  return notify?.desktop === true;
}

/**
 * Show a desktop notification. Resolves true when osascript ran successfully,
 * false otherwise (disabled / non-darwin / missing osascript / timeout).
 * NEVER throws; NEVER blocks beyond the timeout.
 */
export function desktopNotify(title: string, body: string, cfg: AshlrConfig): Promise<boolean> {
  if (!desktopNotifyEnabled(cfg)) return Promise.resolve(false);

  const script =
    `display notification "${escapeAppleScript(body)}" ` +
    `with title "${escapeAppleScript(title)}"`;

  return new Promise<boolean>((resolve) => {
    try {
      execFile(
        'osascript',
        ['-e', script],
        { timeout: OSASCRIPT_TIMEOUT_MS },
        (err) => resolve(!err),
      );
    } catch {
      resolve(false);
    }
  });
}
