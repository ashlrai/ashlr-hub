/**
 * routes/verse/mind/project-label.ts — how Mind names the place a reasoning
 * insight happened.
 *
 * A7 keys insights by the workspace path the engine ran in, verbatim, so the
 * cards used to read "/private/tmp/claude-501/-Users-…/9d28bdb1-…/scratchpad/
 * grokpad · grok · 1×". The card now shows a human label:
 *
 *   1. the REGISTERED name — a saved project (Chat → Projects) whose root is
 *      that folder or contains it, else a project Verse knows from bootstrap;
 *   2. otherwise the folder's own name (`grokpad`), the same rule a saved
 *      project uses when the operator names nothing (defaultWorkspaceName).
 *
 * The full path is never dropped: it rides in the tooltip. A folder under the
 * OS temp directory (an agent's scratchpad, a test fixture) is tagged
 * `scratch` rather than hidden — the insight is real, the place is throwaway.
 * The browser cannot ask the OS for its temp dir, so the well-known locations
 * are matched instead (macOS /tmp, /private/tmp and the per-user
 * /var/folders/…/T; Linux /tmp and /var/tmp; Windows …\AppData\Local\Temp).
 *
 * Two different folders that would read the same (two agents' `scratchpad`s)
 * get a short distinguisher appended, so the Repo facet never offers two
 * identical choices.
 *
 * Framework-free; tested directly.
 */
import type { VerseProject, VerseWorkspace } from '../../../data/api-types.js';
import { defaultWorkspaceName } from '../workspace-model.js';

export interface ProjectLabel {
  /** What the card draws: the registered name, else the folder's own name. */
  label: string;
  /** The path (or slug) exactly as recorded — the tooltip. */
  full: string;
  /** Lives under the OS temp directory: a scratch folder, not a project. */
  scratch: boolean;
}

/** Registered names keyed by `pathKey(root)`. */
export type ProjectNames = ReadonlyMap<string, string>;

/**
 * A comparable form of a path: `/` separators, no trailing separator, the
 * macOS `/private` alias folded (`/tmp` and `/var` are symlinks into it, and
 * the same folder is recorded either way), a home directory as `~` (a project
 * saved as `~/dev/hub` still runs in `/Users/me/dev/hub`).
 */
export function pathKey(path: string): string {
  let p = path.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  p = p.replace(/^\/private(?=\/(?:tmp|var)(?:\/|$))/, '');
  p = p.replace(/^(?:\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\/Users\/[^/]+)(?=\/|$)/, '~');
  return p || '/';
}

const SCRATCH_ROOTS: readonly RegExp[] = [
  /^\/tmp(?:\/|$)/, // also /private/tmp, folded by pathKey
  /^\/var\/tmp(?:\/|$)/,
  /^\/var\/folders\/[^/]+\/[^/]+\/T(?:\/|$)/, // macOS per-user $TMPDIR
  /^[A-Za-z]:\/Windows\/Temp(?:\/|$)/i,
  /\/AppData\/Local\/Temp(?:\/|$)/i,
];

/** Is this folder under the OS temp directory? */
export function isScratchPath(path: string): boolean {
  const key = pathKey(path);
  return SCRATCH_ROOTS.some((re) => re.test(key));
}

/**
 * Registered names by root. Saved projects win (the operator named them),
 * then Verse's known projects; every root of a multi-folder project maps to
 * that project's name.
 */
export function projectNames(
  workspaces: readonly { name: VerseWorkspace['name']; roots: readonly { path: string }[] }[] | null | undefined,
  projects: readonly Pick<VerseProject, 'name' | 'path'>[] | null | undefined,
): Map<string, string> {
  const names = new Map<string, string>();
  const add = (path: string, name: string) => {
    const key = pathKey(path);
    const label = name.trim();
    if (key !== '/' && key !== '~' && label && !names.has(key)) names.set(key, label);
  };
  for (const w of workspaces ?? []) for (const r of w.roots) add(r.path, w.name);
  for (const p of projects ?? []) add(p.path, p.name);
  return names;
}

/** The registered name for `path`: its own root, else the longest registered root containing it. */
function registeredName(path: string, names: ProjectNames): string | null {
  const key = pathKey(path);
  const exact = names.get(key);
  if (exact !== undefined) return exact;
  let best: { root: string; name: string } | null = null;
  for (const [root, name] of names) {
    if (key.startsWith(`${root}/`) && (!best || root.length > best.root.length)) best = { root, name };
  }
  return best?.name ?? null;
}

/** One insight's place, as the card draws it. */
export function projectLabel(repo: string, names: ProjectNames = new Map()): ProjectLabel {
  return { label: registeredName(repo, names) ?? defaultWorkspaceName(repo), full: repo, scratch: isScratchPath(repo) };
}

const short = (name: string) => (name.length > 14 ? `${name.slice(0, 13)}…` : name);

/**
 * What tells two same-label folders apart: the folder's own name when the
 * label is a registered project's (`hub (packages)`), else its parent folder
 * (`scratchpad (9d28bdb1-3f…)`).
 */
function distinguisher(path: string, label: string): string | null {
  const parts = path.replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean);
  const own = parts.at(-1);
  if (own && own !== label) return short(own);
  const parent = parts.at(-2);
  return parent ? short(parent) : null;
}

/**
 * Labels for every repo on a surface at once, so the cards and the Repo facet
 * agree — and two different folders that would read the same get a
 * distinguisher appended.
 */
export function projectLabels(repos: readonly string[], names: ProjectNames = new Map()): Map<string, ProjectLabel> {
  const out = new Map<string, ProjectLabel>();
  for (const repo of new Set(repos)) out.set(repo, projectLabel(repo, names));
  const byLabel = new Map<string, string[]>();
  for (const [repo, l] of out) byLabel.set(l.label, [...(byLabel.get(l.label) ?? []), repo]);
  for (const [label, same] of byLabel) {
    if (same.length < 2) continue;
    for (const repo of same) {
      const extra = distinguisher(repo, label);
      if (extra) out.set(repo, { ...out.get(repo)!, label: `${label} (${extra})` });
    }
  }
  return out;
}
