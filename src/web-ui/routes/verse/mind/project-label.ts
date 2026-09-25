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
 * identical choices; two spellings of ONE folder share one label.
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
 * What tells same-label folders apart, per folder (keyed by `pathKey`):
 * walking up from the folder itself, the NEAREST path segment that no other
 * folder in the group has at that same depth — `grokpad (9d28bdb1-4c1e…)` for
 * two agents' `…/<uuid>/scratchpad/grokpad` (their parents are both
 * `scratchpad`), `Hub (a)` for two folders under one registered project. A
 * segment that only repeats the label (or is the home `~`) says nothing and
 * is skipped. When no single segment is unique, the nearest informative one
 * is returned and `projectLabels` settles whatever still collides.
 */
function distinguishers(keys: readonly string[], label: string): Map<string, string | null> {
  const parts = new Map(keys.map((k) => [k, k.split('/').filter(Boolean).reverse()]));
  const out = new Map<string, string | null>();
  for (const key of keys) {
    const mine = parts.get(key)!;
    let nearest: string | null = null;
    let unique: string | null = null;
    for (let depth = 0; depth < mine.length && unique === null; depth++) {
      const seg = mine[depth]!;
      if (seg === label || seg === '~') continue;
      nearest ??= seg;
      if (keys.every((other) => other === key || parts.get(other)![depth] !== seg)) unique = seg;
    }
    out.set(key, unique ?? nearest);
  }
  return out;
}

/**
 * Labels for every repo on a surface at once, so the cards and the Repo facet
 * agree — and two different folders NEVER read the same:
 *
 *   1. spellings of one folder (`/tmp/x` and `/private/tmp/x`: one `pathKey`)
 *      share one label; each keeps its own `full` path for the tooltip;
 *   2. different folders that would read the same get their nearest
 *      distinguishing ancestor appended, shortened (`distinguishers`);
 *   3. whatever still collides — two ancestors that shorten alike, a folder
 *      with nothing left to tell it apart — is settled by construction: the
 *      whole segment instead of the shortened one, then an ordinal ("#2").
 */
export function projectLabels(repos: readonly string[], names: ProjectNames = new Map()): Map<string, ProjectLabel> {
  // One entry per folder, in a stable order: the labels never depend on the
  // order the insights arrived in.
  const spellings = new Map<string, string[]>();
  for (const repo of [...new Set(repos)].sort()) {
    const key = pathKey(repo);
    spellings.set(key, [...(spellings.get(key) ?? []), repo]);
  }
  const byLabel = new Map<string, string[]>();
  for (const [key, list] of spellings) {
    const label = projectLabel(list[0]!, names).label;
    byLabel.set(label, [...(byLabel.get(label) ?? []), key]);
  }

  const wanted = new Map<string, string>();
  const whole = new Map<string, string>();
  for (const [label, keys] of byLabel) {
    const extra = keys.length > 1 ? distinguishers(keys, label) : null;
    for (const key of keys) {
      const seg = extra?.get(key) ?? null;
      wanted.set(key, seg ? `${label} (${short(seg)})` : label);
      if (seg && short(seg) !== seg) whole.set(key, `${label} (${seg})`);
    }
  }

  const shared = new Map<string, number>();
  for (const l of wanted.values()) shared.set(l, (shared.get(l) ?? 0) + 1);
  const taken = new Set<string>();
  const labelOf = new Map<string, string>();
  for (const key of [...wanted.keys()].sort()) {
    const first = wanted.get(key)!;
    const pick = shared.get(first)! > 1 ? (whole.get(key) ?? first) : first;
    let label = pick;
    for (let n = 2; taken.has(label); n++) label = `${pick} #${n}`;
    taken.add(label);
    labelOf.set(key, label);
  }

  const out = new Map<string, ProjectLabel>();
  for (const [key, list] of spellings) {
    for (const repo of list) out.set(repo, { label: labelOf.get(key)!, full: repo, scratch: isScratchPath(repo) });
  }
  return out;
}
