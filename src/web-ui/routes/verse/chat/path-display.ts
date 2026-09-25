/**
 * routes/verse/chat/path-display.ts — how a file path READS in the chat.
 *
 * Tool payloads carry whatever path the CLI used, and that is usually
 * absolute: `/private/tmp/…/scratchpad/e2e-proj-39/math.ts` for a file the
 * operator knows as `math.ts`. Shown raw, the one part that identifies the
 * file is what the row's ellipsis clips. So every path the transcript draws
 * goes through `displayPath`:
 *
 *   1. relative to the chat's roots (the longest root that contains it wins —
 *      a worktree nested in its repo is its own root). Paths and roots are
 *      compared as `keyOf`s, so `\` vs `/`, a trailing separator, macOS's
 *      `/private/tmp` for `/tmp` and `c:` for `C:` all still match; the rest
 *      is sliced out of the ORIGINAL path, in the CLI's own separators;
 *   2. otherwise as the hub sent it when it is relative or `~/…`;
 *   3. otherwise, when it is long, its last three segments behind `…/`.
 *
 * HOME. The hub rewrites the operator's OWN home to `~` on every payload
 * (sanitizePublicJson) and is the only side that knows which home that is —
 * so a `~/…` path or root already says it, and matches as-is. Nothing here
 * guesses a home from `/Users/<x>`, `/home/<x>` or `C:\Users\<x>`: one that
 * reaches the browser is another account's or /Users/Shared, and drawing it
 * as `~` (or as in-project, via a `~` root) passes it off as the operator's.
 *
 * Display only. The full path stays in the tooltip and is never rewritten in
 * anything handed back to a tool, a search or a jump anchor. (It is in the
 * chat's first-paint chunk, hence the terse body.)
 */
import { createContext, useCallback, useContext } from 'react';
import { pathsIn } from './tool-semantics.js';

const NO_ROOTS: readonly string[] = [];

/** The chat's roots, primary first (Workspace provides them; Transcript can override). */
export const PathRootsContext = createContext<readonly string[]>(NO_ROOTS);

/**
 * A path as the operator's home reads: unchanged. The hub already spelled
 * that home `~`; any other `/Users/<x>` is someone else's (see HOME above).
 * Kept as the one seam home display goes through (SessionRoots uses it).
 */
export function abbreviateHome(path: string): string {
  return path;
}

/**
 * One folder's comparable form: `/` separators, no trailing one, the
 * `/private` alias folded (/tmp, /var and /etc are symlinks into it and roots
 * are not realpath'd), a lower-case drive letter. Only the fold changes the
 * length, and only at the head — so a matched tail maps back onto the original.
 */
function keyOf(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
    .replace(/^\/private(?=\/(?:tmp|var|etc)(?:\/|$))/, '')
    .replace(/^[A-Z](?=:)/, (d) => d.toLowerCase());
}

/** What the transcript draws for `path`; the full path belongs in the tooltip. */
export function displayPath(path: string, roots: readonly string[] = NO_ROOTS): string {
  const key = keyOf(path);
  let root = '';
  for (const raw of roots) {
    const r = keyOf(raw);
    // A bare `/`, `C:` or `\\` root would claim every path on the machine.
    if (r.length > root.length && !/^(?:[a-z]:)?$/.test(r) && (key === r || key.startsWith(`${r}/`))) root = r;
  }
  const own = path.replace(/[\\/]+$/, '');
  // Inside a root: the rest of the path, or — for the root itself — its name.
  if (root) {
    const rest = key.length - root.length - 1;
    return rest > 0 ? own.slice(own.length - rest) : own.slice(Math.max(own.lastIndexOf('/'), own.lastIndexOf('\\')) + 1);
  }
  if (!/^(?:[\\/]|[A-Za-z]:[\\/])/.test(path)) return path.replace(/^\.[\\/]/, '');
  const sep = path.includes('/') ? '/' : '\\';
  const parts = path.replace(/^[A-Za-z]:/, '').split(/[\\/]/).filter(Boolean);
  return parts.length > 4 ? `…${sep}${parts.slice(-3).join(sep)}` : path;
}

/**
 * The file a tool call names, when it runs no command — a shell call keeps
 * its command line verbatim (rewriting a command is not display).
 */
export function inputPath(input: unknown): string | null {
  const rec = input !== null && typeof input === 'object' ? input as Record<string, unknown> : null;
  return rec && typeof rec.command !== 'string' && typeof rec.cmd !== 'string' ? pathsIn(rec)[0] ?? null : null;
}

/** `displayPath` bound to the roots in context. */
export function useDisplayPath(): (path: string) => string {
  const roots = useContext(PathRootsContext);
  return useCallback((path: string) => displayPath(path, roots), [roots]);
}
