/**
 * routes/verse/folder-picker.ts — the native "choose a folder" door.
 *
 * WHY THIS EXISTS. Until now the only way to start a chat in a folder that is
 * not already enrolled was to *type* an absolute path into a text input
 * (NewChatDialog). Every comparable desktop app opens a real directory
 * chooser. This module is that chooser, and nothing else: it resolves to an
 * absolute path or to `null`, and the caller decides what to do with either.
 *
 * WHY IT IS FEATURE-PROBED AND NOT BUILD-FLAGGED. The very same JS bundle is
 * served two ways:
 *
 *   1. Inside the Tauri shell (desktop/), where the Verse window points at
 *      http://127.0.0.1:7777/verse/ and Tauri injects its IPC bridge.
 *   2. By `ashlr verse` in a plain browser, where there is no shell at all.
 *
 * A build-time constant cannot tell those apart — it is one artifact. So the
 * shell is detected at *call* time by probing the injected global, exactly the
 * way desktop/src-tauri/src/shell_contract.js already does. In a browser the
 * probe simply finds nothing: `nativePickerAvailable()` is false and
 * `pickDirectory()` resolves `null` without throwing, so the caller keeps its
 * text input.
 *
 * WHY WE CALL THE IPC COMMAND DIRECTLY. The web UI does not depend on
 * `@tauri-apps/api` (it is not in package.json, and adding it would pull a
 * desktop-only SDK into the browser bundle). `plugin:dialog|open` is the same
 * command `@tauri-apps/plugin-dialog`'s `open()` invokes; going straight to it
 * keeps the browser build free of Tauri code.
 *
 * NATIVE SIDE. The command only answers if all three of these are true:
 *   - `tauri-plugin-dialog` is in desktop/src-tauri/Cargo.toml,
 *   - it is registered in main.rs (`tauri_plugin_dialog::init()`), and
 *   - `dialog:allow-open` is granted to the *remote* Verse origin, in
 *     desktop/src-tauri/capabilities/verse-remote.json — the Verse page is a
 *     remote URL, so a capability without a `remote` block does not reach it.
 * A missing permission is rejected at the IPC boundary, which is why every
 * failure here is caught and reported as `null` rather than thrown.
 *
 * Pure aside from the one IPC call. No React.
 */

/** The IPC command `@tauri-apps/plugin-dialog`'s `open()` invokes. */
const DIALOG_OPEN_COMMAND = 'plugin:dialog|open';

/** Shown as the chooser's window title on platforms that use one. */
const DIALOG_TITLE = 'Choose a project folder';

/**
 * Tauri 2 injects this into every webview it owns, remote origins included.
 * Only the one method we need is modelled; the real object has far more.
 */
type TauriInvoke = (command: string, args?: unknown) => unknown;

interface TauriBridge {
  invoke: TauriInvoke;
}

interface TauriGlobals {
  /** Always present inside a Tauri 2 webview. */
  __TAURI_INTERNALS__?: { invoke?: unknown };
  /** Present only when `app.withGlobalTauri` is on. Probed as a fallback. */
  __TAURI__?: { core?: { invoke?: unknown } };
}

/**
 * The live IPC bridge, or `null` when this code is not running inside the
 * Tauri shell. Re-read on every call on purpose: the global is injected by an
 * initialization script, and nothing guarantees this module was evaluated
 * after it.
 */
function tauriBridge(): TauriBridge | null {
  // `globalThis` rather than `window` so this is also safe under a non-DOM
  // module graph (SSR, a node-environment test) instead of throwing.
  const globals = globalThis as unknown as TauriGlobals;

  const internal = globals.__TAURI_INTERNALS__?.invoke;
  if (typeof internal === 'function') return { invoke: internal as TauriInvoke };

  const global = globals.__TAURI__?.core?.invoke;
  if (typeof global === 'function') return { invoke: global as TauriInvoke };

  return null;
}

/** True when a native directory picker is reachable (i.e. running inside the Tauri shell). */
export function nativePickerAvailable(): boolean {
  return tauriBridge() !== null;
}

/** Opens the native directory chooser. Resolves to an absolute path, or null if the user cancelled. */
export async function pickDirectory(): Promise<string | null> {
  const bridge = tauriBridge();
  if (!bridge) return null;

  try {
    // Arg shape mirrors @tauri-apps/plugin-dialog: the Rust command takes a
    // single `options` parameter. `multiple: false` keeps the answer a scalar,
    // though normalisePickedPath does not rely on that.
    const raw = await bridge.invoke(DIALOG_OPEN_COMMAND, {
      options: {
        directory: true,
        multiple: false,
        recursive: false,
        title: DIALOG_TITLE,
      },
    });
    return normalisePickedPath(raw);
  } catch {
    // A rejected IPC call means the shell said no — the permission is not
    // granted, the plugin is not registered, or the dialog failed to open.
    // None of those are the caller's problem: it falls back to typing a path.
    return null;
  }
}

/** Depth cap for the unwrapping below, so a self-referential reply cannot spin. */
const MAX_UNWRAP_DEPTH = 4;

/**
 * Reduce whatever the dialog plugin returned to one plain absolute path.
 *
 * The shapes seen across plugin versions and platforms:
 *   - `"/Users/me/project"`                  — the common case
 *   - `null` / `undefined`                   — the user cancelled
 *   - `["/Users/me/project"]`                — an array even for multiple:false
 *   - `{ path: "/Users/me/project" }`        — the FileResponse-style wrapper
 *   - `"file:///Users/me/my%20project"`      — a URL-ish value needing decoding
 * Anything else — a number, an empty array, a relative path — is malformed and
 * becomes `null`. A half-understood path is worse than no path: the caller
 * would hand it to the backend as a session root.
 */
function normalisePickedPath(value: unknown, depth = 0): string | null {
  if (depth > MAX_UNWRAP_DEPTH) return null;

  if (Array.isArray(value)) {
    return value.length > 0 ? normalisePickedPath(value[0], depth + 1) : null;
  }

  if (value !== null && typeof value === 'object') {
    const path = (value as { path?: unknown }).path;
    return typeof path === 'string' ? normalisePickedPath(path, depth + 1) : null;
  }

  if (typeof value !== 'string') return null;

  const decoded = decodeFileUrl(value.trim());
  if (!decoded) return null;
  // A NUL cannot occur in a real path and would truncate it in any C API it
  // eventually reaches.
  if (decoded.includes('\0')) return null;
  return isAbsolutePath(decoded) ? decoded : null;
}

/**
 * Turn `file:///Users/me/my%20project` into `/Users/me/my project`, and leave
 * a plain path untouched. Any other scheme (http:, data:, …) is not a local
 * folder and is rejected.
 */
function decodeFileUrl(value: string): string | null {
  if (value === '') return null;
  // No scheme marker at all: already a plain path, hand it back untouched.
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return value;
  // `C:\Users\me` also matches the scheme shape (one letter, then a colon), so
  // the drive-letter case is rescued here before anything is rejected.
  if (/^[A-Za-z]:[\\/]/.test(value)) return value;
  if (!/^file:\/\//i.test(value)) return null;

  let pathname: string;
  try {
    pathname = new URL(value).pathname;
  } catch {
    return null;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null; // A malformed percent-escape.
  }
  // `file:///C:/Users/me` decodes to `/C:/Users/me`; drop the leading slash so
  // the result is the real Windows path.
  return /^\/[A-Za-z]:[\\/]/.test(decoded) ? decoded.slice(1) : decoded;
}

/** POSIX root, a Windows drive, or a UNC share. Nothing else is usable as a session root. */
function isAbsolutePath(value: string): boolean {
  if (value.startsWith('\\\\')) return true; // \\server\share
  if (value.startsWith('/')) return true;
  return /^[A-Za-z]:[\\/]/.test(value);
}
