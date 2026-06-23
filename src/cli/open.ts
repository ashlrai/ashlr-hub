/**
 * cli/open.ts — Launch items in editor, file manager, or terminal.
 *
 * All launchers use spawn (detached, unref'd) so the CLI process exits
 * immediately. Errors are swallowed — never throw; open operations are
 * best-effort UI conveniences.
 *
 * Cross-platform: macOS uses `open`, Windows uses `explorer`/`start`, Linux
 * uses `xdg-open`. The editor deep-link URL is built by a pure, OS-agnostic
 * helper (`editorDeepLink`) so the same input yields the same URL on any host.
 */

import { spawn } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import type { AshlrConfig } from '../core/types.js';

// ---------------------------------------------------------------------------
// Internal helpers
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

/**
 * Treat a path as absolute if it looks absolute on EITHER platform — POSIX
 * (`/x`), Windows drive (`C:\x` / `C:/x`), or UNC/rooted (`\x`). This avoids
 * `path.resolve()` rewriting a POSIX path into a drive-relative Windows path
 * (and vice-versa), which would corrupt deep links built on the other host.
 */
function isAbsLike(p: string): boolean {
  return /^([A-Za-z]:)?[\\/]/.test(p) || isAbsolute(p);
}

/** Open a URL/handler via the platform's default opener (best-effort). */
function openUrl(url: string): void {
  if (process.platform === 'darwin') fire('open', [url]);
  else if (process.platform === 'win32') fire('cmd', ['/c', 'start', '', url]);
  else fire('xdg-open', [url]);
}

// ---------------------------------------------------------------------------
// Pure deep-link builder (platform-agnostic — safe to unit-test anywhere)
// ---------------------------------------------------------------------------

/**
 * Build an editor deep-link URL (`cursor://file…` or `vscode://file…`) for an
 * absolute path.
 *
 * Pure and OS-independent:
 *  - normalizes `\` → `/` so Windows paths produce a valid URL;
 *  - ensures a single leading slash (`C:/Users/…` → `/C:/Users/…`);
 *  - percent-encodes each path segment (spaces, `&`, etc.) but preserves a
 *    drive-letter colon (`C:`), which editors expect literal in the URL;
 *  - does NOT platform-resolve, so a POSIX input stays POSIX and a Windows
 *    input stays Windows regardless of the host OS.
 */
export function editorDeepLink(path: string, editor: AshlrConfig['editor']): string {
  const abs = isAbsLike(path) ? path : resolve(path);
  let p = abs.replace(/\\/g, '/');
  if (!p.startsWith('/')) p = `/${p}`; // Windows "C:/…" → "/C:/…"
  const enc = p
    .split('/')
    .map((seg) => (/^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)))
    .join('/');
  const scheme = editor === 'vscode' ? 'vscode' : 'cursor';
  return `${scheme}://file${enc}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Open `path` in the configured editor using a deep-link URL.
 *
 *  - Cursor → `cursor://file<abs>`   (default)
 *  - VSCode → `vscode://file<abs>`   (when `cfg.editor === 'vscode'`)
 *
 * The deep link is launched via the platform opener. If the scheme handler is
 * not registered (e.g. the app is not installed) the OS silently does nothing,
 * so callers may retry via openInFinder.
 */
export function openInEditor(path: string, cfg: AshlrConfig): void {
  openUrl(editorDeepLink(path, cfg.editor));
}

/**
 * Reveal `path` in the OS file manager (Finder / Explorer / default handler).
 * Opens directories in the file manager and files with their default app.
 */
export function openInFinder(path: string): void {
  const abs = isAbsLike(path) ? path : resolve(path);
  if (process.platform === 'darwin') fire('open', [abs]);
  else if (process.platform === 'win32') fire('explorer', [abs]);
  else fire('xdg-open', [abs]);
}

/**
 * Open a new terminal window cd'd to `path` (best-effort).
 *
 *  - macOS   → `open -a Terminal <dir>`
 *  - Windows → `start cmd /k cd /d <dir>`
 *  - Linux   → `x-terminal-emulator --working-directory <dir>`
 *
 * No guarantee for non-default terminals (iTerm2, Windows Terminal, etc.).
 */
export function openInTerminal(path: string): void {
  const abs = isAbsLike(path) ? path : resolve(path);
  if (process.platform === 'darwin') {
    fire('open', ['-a', 'Terminal', abs]);
  } else if (process.platform === 'win32') {
    fire('cmd', ['/c', 'start', 'cmd', '/k', `cd /d "${abs}"`]);
  } else {
    fire('x-terminal-emulator', ['--working-directory', abs]);
  }
}
