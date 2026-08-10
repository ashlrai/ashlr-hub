/**
 * cli/open.ts — Launch items in editor, file manager, or terminal.
 *
 * All launchers use spawn (detached, unref'd). They resolve after the child
 * emits `spawn` or `error`, without waiting for the graphical application.
 * Spawn errors become false; open operations remain best-effort UI
 * conveniences.
 *
 * Cross-platform: macOS uses `open`, Windows uses the registered URL handler
 * or Explorer directly, and Linux uses `xdg-open`. The editor deep-link URL is
 * built by a pure, OS-agnostic
 * helper (`editorDeepLink`) so the same input yields the same URL on any host.
 */

import { spawn } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve, win32 } from 'node:path';
import type { AshlrConfig } from '../core/types.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

declare const trustedWindowsExecutable: unique symbol;
type TrustedWindowsExecutable = string & { readonly [trustedWindowsExecutable]: true };
type LauncherCommand = TrustedWindowsExecutable | 'open' | 'xdg-open' | 'x-terminal-emulator';

interface WindowsSystemLaunchers {
  cmd: TrustedWindowsExecutable;
  explorer: TrustedWindowsExecutable;
  fileProtocolHandler: string;
  rundll32: TrustedWindowsExecutable;
}

interface FireOptions {
  cwd?: string;
}

/**
 * Fire-and-forget a closed set of OS launchers without invoking a shell.
 * Detaches the child process so the parent can exit without waiting. Both
 * synchronous launch failures and asynchronous `error` events are swallowed.
 * Resolves true only after the child emits `spawn`, false on synchronous throw
 * or `error`. A single-settle guard makes a later event unable to reverse the
 * reported outcome. Even true cannot prove a graphical handler ultimately
 * opened.
 */
function fire(
  cmd: LauncherCommand,
  args: readonly string[],
  options: FireOptions = {},
): Promise<boolean> {
  return new Promise((resolveOutcome) => {
    let settled = false;
    const settle = (outcome: boolean): void => {
      if (settled) return;
      settled = true;
      resolveOutcome(outcome);
    };
    try {
      const child = spawn(cmd, [...args], {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        detached: true,
        shell: false,
        stdio: 'ignore',
      });
      child.once('spawn', () => settle(true));
      child.once('error', () => settle(false));
      child.unref();
    } catch {
      settle(false);
    }
  });
}

const WINDOWS_LOCAL_DRIVE_ROOT = /^[A-Za-z]:\\$/;
const WINDOWS_FORBIDDEN_PATH_CHAR = /["<>|]/;
const WINDOWS_FORBIDDEN_SEGMENT_CHAR = /[:*?]/;
const WINDOWS_COMMAND_TEXT_META = /[&^()%!]/;

function strictWindowsDriveAbsolute(path: string): boolean {
  if (
    path.length === 0 ||
    path !== path.trim() ||
    WINDOWS_FORBIDDEN_PATH_CHAR.test(path) ||
    [...path].some((char) => char.codePointAt(0)! < 0x20)
  ) {
    return false;
  }
  if (!win32.isAbsolute(path)) return false;
  const parsed = win32.parse(path);
  if (!WINDOWS_LOCAL_DRIVE_ROOT.test(parsed.root)) return false;
  return !path.slice(parsed.root.length).split(/[\\/]/).some((part) =>
    part === '.' || part === '..' || WINDOWS_FORBIDDEN_SEGMENT_CHAR.test(part),
  );
}

function canonicalWindowsPath(path: string, kind: 'directory' | 'file'): string | null {
  if (!strictWindowsDriveAbsolute(path)) return null;
  try {
    const canonical = realpathSync.native(win32.normalize(path));
    if (!strictWindowsDriveAbsolute(canonical)) return null;
    const stat = statSync(canonical);
    if (kind === 'directory' ? !stat.isDirectory() : !stat.isFile()) return null;
    return win32.normalize(canonical);
  } catch {
    return null;
  }
}

function canonicalWindowsSystemFile(systemRoot: string, relativePath: string): string | null {
  const expected = win32.join(systemRoot, relativePath);
  const canonical = canonicalWindowsPath(expected, 'file');
  if (!canonical || canonical.toLowerCase() !== win32.normalize(expected).toLowerCase()) return null;
  const relative = win32.relative(systemRoot, canonical);
  if (relative === '' || relative.startsWith(`..${win32.sep}`) || relative === '..' || win32.isAbsolute(relative)) {
    return null;
  }
  return canonical;
}

/**
 * Resolve Windows launchers only through a canonical drive-root `Windows`
 * directory. Custom Windows directories fail closed until a trusted native
 * system-directory API is available; an arbitrary environment-selected
 * `C:\\repo\\Windows` tree is never accepted.
 *
 * Residual boundary: validation and spawn are path-based, so there is an
 * unavoidable TOCTOU interval. This assumes standard Windows ACLs prevent an
 * unprivileged process from replacing SystemRoot binaries after validation.
 * The canonical paths themselves are retained unchanged through spawn.
 */
function windowsSystemLaunchers(): WindowsSystemLaunchers | null {
  const rawRoot = process.env['SystemRoot'];
  if (typeof rawRoot !== 'string' || !strictWindowsDriveAbsolute(rawRoot)) return null;
  const systemRoot = canonicalWindowsPath(rawRoot, 'directory');
  if (
    !systemRoot ||
    win32.basename(systemRoot).toLowerCase() !== 'windows' ||
    win32.dirname(systemRoot).toLowerCase() !== win32.parse(systemRoot).root.toLowerCase() ||
    WINDOWS_COMMAND_TEXT_META.test(systemRoot)
  ) return null;

  const cmd = canonicalWindowsSystemFile(systemRoot, 'System32\\cmd.exe');
  const explorer = canonicalWindowsSystemFile(systemRoot, 'explorer.exe');
  const rundll32 = canonicalWindowsSystemFile(systemRoot, 'System32\\rundll32.exe');
  const urlDll = canonicalWindowsSystemFile(systemRoot, 'System32\\url.dll');
  if (!cmd || !explorer || !rundll32 || !urlDll) return null;

  return {
    cmd: cmd as TrustedWindowsExecutable,
    explorer: explorer as TrustedWindowsExecutable,
    fileProtocolHandler: `${urlDll},FileProtocolHandler`,
    rundll32: rundll32 as TrustedWindowsExecutable,
  };
}

function canonicalWindowsTerminalDirectory(path: string): string | null {
  // Root-relative (`\foo`) and UNC (`\\server\share`) paths are not local
  // drive-absolute paths. Refuse them instead of inheriting drive context or
  // crossing onto a network filesystem.
  if (win32.isAbsolute(path) && !strictWindowsDriveAbsolute(path)) return null;
  const abs = isAbsLike(path) ? path : resolve(path);
  if (!strictWindowsDriveAbsolute(abs)) return null;
  const canonical = canonicalWindowsPath(abs, 'directory');
  if (canonical) return canonical;

  const canonicalFile = canonicalWindowsPath(abs, 'file');
  if (!canonicalFile) return null;
  return canonicalWindowsPath(win32.dirname(canonicalFile), 'directory');
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
function openUrl(url: string): Promise<boolean> {
  if (process.platform === 'darwin') return fire('open', [url]);
  else if (process.platform === 'win32') {
    const launchers = windowsSystemLaunchers();
    if (!launchers) return Promise.resolve(false);
    // `start` is a cmd.exe built-in and would reparse the URL as shell input.
    // FileProtocolHandler delegates the already encoded URI to its registered
    // application while keeping both the DLL entry point and URI as argv.
    return fire(launchers.rundll32, [launchers.fileProtocolHandler, url]);
  }
  return fire('xdg-open', [url]);
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
 * so callers may retry via openInFinder. Returns false when a safe launcher
 * cannot be resolved or the child emits an error before its spawn event.
 */
export function openInEditor(path: string, cfg: AshlrConfig): Promise<boolean> {
  return openUrl(editorDeepLink(path, cfg.editor));
}

/**
 * Reveal `path` in the OS file manager (Finder / Explorer / default handler).
 * Opens directories in the file manager and files with their default app.
 * Returns false when a safe launcher cannot be resolved or spawn fails.
 */
export function openInFinder(path: string): Promise<boolean> {
  const abs = isAbsLike(path) ? path : resolve(path);
  if (process.platform === 'darwin') return fire('open', [abs]);
  if (process.platform === 'win32') {
    const launchers = windowsSystemLaunchers();
    return launchers ? fire(launchers.explorer, [abs]) : Promise.resolve(false);
  }
  return fire('xdg-open', [abs]);
}

/**
 * Open a new terminal window cd'd to `path` (best-effort).
 *
 *  - macOS   → `open -a Terminal <dir>`
 *  - Windows → detached `cmd.exe` with its working directory set directly
 *  - Linux   → `x-terminal-emulator --working-directory <dir>`
 *
 * No guarantee for non-default terminals (iTerm2, Windows Terminal, etc.).
 * On Windows, nonexistent and non-file/non-directory targets fail closed.
 * Automated Windows acceptance validates executable identity and cmd/start
 * parsing only; a real interactive desktop still requires manual GUI
 * acceptance before terminal usability can be claimed.
 */
export function openInTerminal(path: string): Promise<boolean> {
  const abs = isAbsLike(path) ? path : resolve(path);
  if (process.platform === 'darwin') {
    return fire('open', ['-a', 'Terminal', abs]);
  }
  if (process.platform === 'win32') {
    const launchers = windowsSystemLaunchers();
    const cwd = canonicalWindowsTerminalDirectory(path);
    if (!launchers || !cwd) return Promise.resolve(false);
    // Windows Terminal's usual wt.exe app-execution alias is per-user and
    // PATH-resolved. Without native package/signature discovery it is not a
    // trustworthy executable boundary, so use only the canonical system cmd.
    // A direct detached cmd with ignored stdio can immediately exit. Use the
    // trusted outer cmd only to execute a fixed `start` command. The only
    // derived value in command text is the already-canonical System32 cmd path;
    // the user-controlled target exists solely in spawn's structural cwd.
    const startCommand = `start "" "${launchers.cmd}" /d /k`;
    return fire(launchers.cmd, ['/d', '/v:off', '/s', '/c', startCommand], { cwd });
  }
  return fire('x-terminal-emulator', ['--working-directory', abs]);
}
