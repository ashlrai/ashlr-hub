/**
 * cli/open.ts — Launch items in editor, Finder, or Terminal.
 *
 * All launchers use spawn (detached, unref'd) so the CLI process exits
 * immediately. Errors are swallowed — never throw; open operations are
 * best-effort UI conveniences.
 */

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { AshlrConfig } from '../core/types.js';

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget spawn. Detaches the child process so the parent can exit
 * without waiting. Errors are silently discarded.
 */
function fire(cmd: string, args: string[]): void {
  try {
    const child = spawn(cmd, args, {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch {
    // best-effort — never propagate
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Open `path` in the configured editor using a deep link URL.
 *
 * Strategy:
 *  1. Cursor  → `open "cursor://file/<abs>"`
 *     Fallback: `open -a Cursor <path>`
 *  2. VSCode  → `open "vscode://file/<abs>"`
 *     Fallback: `open -a "Visual Studio Code" <path>`
 *
 * The deep link is tried first; if the URL scheme handler is not registered
 * (e.g. app not installed) macOS silently does nothing, so we do not attempt
 * explicit fallback detection — callers are welcome to retry via openInFinder.
 */
export function openInEditor(path: string, cfg: AshlrConfig): void {
  const abs = resolve(path);

  // Percent-encode each path segment so paths containing spaces or reserved
  // URI characters (e.g. "Keys & Recovery", "Rent Application.pdf", "tts
  // agents") still yield a valid URL. `abs` always begins with '/', so the
  // first split element is the empty string and the join restores the leading
  // slash; encodeURIComponent never emits '/', so separators are preserved.
  const enc = abs.split('/').map(encodeURIComponent).join('/');

  if (cfg.editor === 'vscode') {
    // Deep link: vscode://file<enc>  (enc already starts with '/')
    const url = `vscode://file${enc}`;
    fire('open', [url]);
  } else {
    // Default: Cursor deep link: cursor://file<enc>
    const url = `cursor://file${enc}`;
    fire('open', [url]);
  }
}

/**
 * Reveal `path` in macOS Finder.
 * Uses `open <path>` which opens directories in Finder and files with their
 * default app. For "reveal in Finder" semantics on a file, callers can pass
 * the parent directory instead.
 */
export function openInFinder(path: string): void {
  const abs = resolve(path);
  fire('open', [abs]);
}

/**
 * Open a new Terminal window cd'd to `path` (best-effort).
 *
 * Uses `open -a Terminal <path>`. On macOS this opens a new Terminal window
 * at the given directory when path is a directory. For files, Terminal opens
 * at the parent directory. No guarantee for iTerm2 or other terminals — this
 * targets the system Terminal.app only.
 */
export function openInTerminal(path: string): void {
  const abs = resolve(path);
  fire('open', ['-a', 'Terminal', abs]);
}
