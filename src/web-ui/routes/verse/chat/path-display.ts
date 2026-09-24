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
 *      a worktree nested in its repo is its own root; a `~/…` root matches the
 *      absolute paths its tools report);
 *   2. otherwise `~`-abbreviated when it sits under a home directory;
 *   3. otherwise, when it is long, its last three segments behind `…/`.
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

/** `/Users/me/x` → `~/x` (also `/home/me/…`). */
export function abbreviateHome(path: string): string {
  const home = /^\/(?:Users|home)\/[^/]+(?=\/|$)/.exec(path);
  return home ? `~${path.slice(home[0].length)}` : path;
}

/** What the transcript draws for `path`; the full path belongs in the tooltip. */
export function displayPath(path: string, roots: readonly string[] = NO_ROOTS): string {
  const short = abbreviateHome(path);
  let root = '';
  for (const raw of roots) {
    const r = abbreviateHome(raw).replace(/\/+$/, '');
    if (r.length > root.length && (short === r || short.startsWith(`${r}/`))) root = r;
  }
  // Inside a root: the rest of the path, or — for the root itself — its name.
  if (root) return short.slice(root.length + 1) || root.slice(root.lastIndexOf('/') + 1);
  if (short !== path || !path.startsWith('/')) return short.replace(/^\.\//, '');
  const parts = path.split('/').filter(Boolean);
  return parts.length > 4 ? `…/${parts.slice(-3).join('/')}` : path;
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
