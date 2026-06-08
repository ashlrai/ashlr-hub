/**
 * Deep-link and Finder helpers for the Raycast extension.
 *
 * These mirror src/cli/open.ts but use Raycast's `open` utility instead of
 * shelling out, so they integrate cleanly with the Raycast sandbox.
 */
import { open } from "@raycast/api";

/**
 * Open `path` in the configured editor using a deep link.
 *
 * Cursor:  cursor://file/<absolute-path>
 * VSCode:  vscode://file/<absolute-path>
 */
export function openInEditor(path: string, editor: "cursor" | "vscode"): void {
  const scheme = editor === "cursor" ? "cursor" : "vscode";
  // Encode the path component; preserve leading slash for absolute paths.
  const encoded = encodeURIComponent(path).replace(/%2F/g, "/");
  const url = `${scheme}://file/${encoded}`;
  open(url).catch(() => {
    // Best-effort — if the editor isn't installed the open call silently fails.
  });
}

/**
 * Reveal `path` in the macOS Finder.
 *
 * Uses the `open` Raycast API which calls macOS `open` under the hood,
 * equivalent to `open <path>` in the shell.
 */
export function openInFinder(path: string): void {
  open(path).catch(() => {
    // Best-effort.
  });
}
