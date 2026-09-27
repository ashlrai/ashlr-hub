/**
 * wiki/plan.ts — which pages a repo's wiki has, and when each one is stale.
 *
 * Built-in pages: Overview, Module map, Key flows, Data stores, Commands, and
 * "How to change <X>" for the most central modules (or the steering file's
 * focus areas). Steering can add custom pages, include/exclude pages, and (Devin
 * compatibility) replace the built-ins with its own page list.
 *
 * STALENESS is content-addressed: a page's inputHash covers its spec, the git
 * blob id of every input file, and pseudo-inputs (`@tree` = the set of paths,
 * `@steering` = the steering files). A new commit that does not touch a page's
 * inputs leaves it fresh — only stale pages are regenerated.
 */

import { createHash } from 'node:crypto';

import type { RepoFacts, ModuleInfo } from './facts.js';
import type { WikiSteering } from './steering.js';
import { WIKI_GENERATOR_VERSION, type WikiPageSpec } from './types.js';
import { isTestFile } from './scan.js';

const DEFAULT_MAX_PAGES = 24;
const DEFAULT_CHANGE_PAGES = 4;
const MAX_INPUTS = 14;

export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 72) || 'page';
}

function uniq(list: Iterable<string>, max = MAX_INPUTS): string[] {
  const out: string[] = [];
  for (const x of list) {
    if (!out.includes(x)) out.push(x);
    if (out.length >= max) break;
  }
  return out;
}

/** A module's most-imported source files that were read (facts.ts orders topFiles). */
function topSourceFiles(m: ModuleInfo, facts: RepoFacts, max: number): string[] {
  return m.topFiles.filter((f) => !isTestFile(f) && facts.lineIndex[f] !== undefined).slice(0, max);
}

/** Find the module a focus area names: exact key, key suffix, or substring. */
export function moduleForFocus(focus: string, modules: readonly ModuleInfo[]): ModuleInfo | null {
  const f = focus.replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase();
  return (
    modules.find((m) => m.key.toLowerCase() === f) ??
    modules.find((m) => m.key.toLowerCase().endsWith(`/${f}`)) ??
    modules.find((m) => m.key.toLowerCase().includes(f)) ??
    null
  );
}

/** Files whose path mentions any keyword of `text` (for custom/focus pages with no module). */
function filesForKeywords(text: string, facts: RepoFacts, max: number): string[] {
  const words = text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
  if (words.length === 0) return [];
  const scored: Array<{ f: string; s: number }> = [];
  for (const f of Object.keys(facts.lineIndex)) {
    if (isTestFile(f)) continue;
    const lower = f.toLowerCase();
    const s = words.reduce((acc, w) => acc + (lower.includes(w) ? 1 : 0), 0);
    if (s > 0) scored.push({ f, s });
  }
  return scored.sort((a, b) => b.s - a.s || a.f.localeCompare(b.f)).slice(0, max).map((x) => x.f);
}

function matches(spec: Pick<WikiPageSpec, 'id' | 'title'>, list: readonly string[]): boolean {
  const id = spec.id.toLowerCase();
  const title = spec.title.toLowerCase();
  return list.some((x) => {
    const v = x.toLowerCase();
    return v === id || v === title || slugify(v) === id;
  });
}

/** Plan the wiki for a repo. Deterministic for identical facts + steering. */
export function planPages(facts: RepoFacts, steering: WikiSteering): WikiPageSpec[] {
  const pseudo = ['@steering'];
  const specs: WikiPageSpec[] = [];
  const entryFiles = facts.entrypoints.map((e) => e.file);
  const readme = facts.readme?.cite.file;
  const rootManifests = facts.manifests.filter((m) => !m.includes('/'));

  specs.push({
    id: 'overview',
    title: 'Overview',
    kind: 'overview',
    purpose: `What ${facts.name} is, how it is laid out, and where to start reading.`,
    inputs: uniq([...(readme ? [readme] : []), ...rootManifests, ...entryFiles]),
    pseudo: [...pseudo],
    notes: [],
  });

  if (!steering.devinDefinesPages) {
    const hasModules = facts.modules.some((m) => m.sourceFiles > 0);
    if (hasModules) {
      specs.push({
        id: 'modules',
        title: 'Module map',
        kind: 'modules',
        purpose: 'The major modules, what each owns, and how they depend on one another.',
        inputs: uniq(facts.modules.filter((m) => m.entry).map((m) => m.entry!), 12),
        pseudo: [...pseudo, '@tree'],
        notes: [],
      });
    }
    const routeFiles = facts.routes.map((r) => r.cite.file);
    if (entryFiles.length > 0 || routeFiles.length > 0) {
      specs.push({
        id: 'flows',
        title: 'Key flows',
        kind: 'flows',
        purpose: 'How a request, command or job travels through the code, from entry point to effect.',
        inputs: uniq([...entryFiles, ...routeFiles]),
        pseudo: [...pseudo],
        notes: [],
      });
    }
    if (facts.dataStores.length > 0 || facts.envVars.length > 0) {
      specs.push({
        id: 'data',
        title: 'Data stores',
        kind: 'data',
        purpose: 'Where state lives — databases, files, caches — and the configuration that points at it.',
        inputs: uniq([...facts.dataStores.map((d) => d.cite.file), ...facts.envVars.map((e) => e.cite.file)]),
        pseudo: [...pseudo],
        notes: [],
      });
    }
    if (facts.scripts.length > 0 || facts.makeTargets.length > 0 || facts.bins.length > 0) {
      specs.push({
        id: 'commands',
        title: 'Commands',
        kind: 'commands',
        purpose: 'How to build, test, run and ship it: scripts, CLIs and make targets.',
        inputs: uniq([...facts.scripts.map((s) => s.cite.file), ...facts.makeTargets.map((t) => t.cite.file), ...facts.bins.map((b) => b.cite.file)]),
        pseudo: [...pseudo],
        notes: [],
      });
    }

    // "How to change X": steering focus areas first, then the most central modules.
    const changeTargets: Array<{ focus: string; module: ModuleInfo | null }> = [];
    for (const focus of steering.focus) changeTargets.push({ focus, module: moduleForFocus(focus, facts.modules) });
    if (steering.focus.length === 0) {
      for (const m of facts.modules) {
        if (changeTargets.length >= DEFAULT_CHANGE_PAGES) break;
        if (m.key === '(root)' || m.sourceFiles < 2) continue;
        changeTargets.push({ focus: m.key, module: m });
      }
    }
    for (const t of changeTargets) {
      const inputs = t.module ? topSourceFiles(t.module, facts, 10) : filesForKeywords(t.focus, facts, 10);
      if (inputs.length === 0) continue;
      const id = `change-${slugify(t.module?.key ?? t.focus)}`;
      if (specs.some((s) => s.id === id)) continue;
      specs.push({
        id,
        title: `How to change ${t.module?.key ?? t.focus}`,
        kind: 'change',
        purpose: `Where to make a change in ${t.module?.key ?? t.focus}, what else it touches, and how to verify it.`,
        parent: hasModules ? 'modules' : 'overview',
        inputs,
        pseudo: [...pseudo],
        focus: t.module?.key ?? t.focus,
        notes: [],
      });
    }
  }

  // Custom pages (Ashlr `pages` or Devin `pages`).
  const titleToId = new Map<string, string>(specs.map((s) => [s.title.toLowerCase(), s.id]));
  const customIds: string[] = [];
  for (const page of steering.pages) {
    let id = `custom-${slugify(page.title)}`;
    let n = 2;
    while (specs.some((s) => s.id === id)) id = `custom-${slugify(page.title)}-${n++}`;
    titleToId.set(page.title.toLowerCase(), id);
    customIds.push(id);
    const mod = moduleForFocus(page.title, facts.modules);
    const inputs = mod ? topSourceFiles(mod, facts, 10) : filesForKeywords(`${page.title} ${page.purpose}`, facts, 10);
    specs.push({
      id,
      title: page.title,
      kind: 'custom',
      purpose: page.purpose,
      inputs: inputs.length > 0 ? inputs : uniq(entryFiles, 6),
      pseudo: [...pseudo],
      focus: mod?.key ?? page.title,
      notes: page.notes,
    });
  }
  // Resolve custom parents by title (after all titles are known).
  steering.pages.forEach((page, i) => {
    if (!page.parent) return;
    const spec = specs.find((s) => s.id === customIds[i]);
    const parentId = titleToId.get(page.parent.toLowerCase());
    if (spec && parentId && parentId !== spec.id) spec.parent = parentId;
  });

  let out = specs;
  if (steering.include.length > 0) out = out.filter((s) => matches(s, steering.include) || s.kind === 'custom');
  if (steering.exclude.length > 0) out = out.filter((s) => !matches(s, steering.exclude));
  const kept = new Set(out.map((s) => s.id));
  for (const s of out) if (s.parent && !kept.has(s.parent)) delete s.parent;
  return out.slice(0, steering.maxPages ?? DEFAULT_MAX_PAGES);
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Hash of every listed path — the `@tree` pseudo-input. */
export function treeHash(paths: Iterable<string>): string {
  return sha([...paths].sort().join('\n')).slice(0, 24);
}

/** Hash of a spec's static parts (plus the repo notes, which shape every page). */
export function specHash(spec: WikiPageSpec, repoNotes: readonly string[]): string {
  return sha(
    JSON.stringify({
      v: WIKI_GENERATOR_VERSION,
      id: spec.id,
      title: spec.title,
      kind: spec.kind,
      purpose: spec.purpose,
      focus: spec.focus ?? null,
      notes: spec.notes,
      repoNotes,
    }),
  ).slice(0, 24);
}

export interface HashContext {
  blobs: ReadonlyMap<string, string>;
  tree: string;
  steering: string;
}

/** The freshness hash for a page — recomputable from stored meta alone. */
export function inputHash(spec: { specHash: string; inputs: readonly string[]; pseudo: readonly string[] }, ctx: HashContext): string {
  const inputs = spec.inputs.map((rel) => `${rel}\u0000${ctx.blobs.get(rel) ?? 'missing'}`);
  const pseudo = spec.pseudo.map((p) => (p === '@tree' ? `@tree:${ctx.tree}` : p === '@steering' ? `@steering:${ctx.steering}` : p));
  return sha(JSON.stringify({ s: spec.specHash, inputs, pseudo })).slice(0, 32);
}
