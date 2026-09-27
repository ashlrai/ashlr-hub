/**
 * wiki/steering.ts — per-repo wiki steering, read (never written) from the repo.
 *
 *   <repo>/.ashlr/wiki.json   — Ashlr's format (wins field-by-field)
 *   <repo>/.devin/wiki.json   — Devin DeepWiki's format, honoured for compatibility
 *
 * Ashlr format (every field optional):
 *   {
 *     "include":     ["overview", "modules"],   // page ids/titles to keep (default: all)
 *     "exclude":     ["data"],                  // page ids/titles to drop
 *     "focus":       ["src/core/run", "billing"], // areas that get a "How to change …" page
 *     "notes":       ["The daemon executes dist/, not src/"], // fed to every page prompt
 *     "ignorePaths": ["fixtures/", "legacy/"],  // path prefixes left out of the scan
 *     "pages":       [{ "title": "Auth", "purpose": "…", "parent": "Overview", "notes": ["…"] }],
 *     "maxPages":    20,
 *     "localOnly":   true                      // never send this repo's code to a remote model
 *   }
 * `localOnly` can only RESTRICT: a repo file can keep its code on this machine,
 * never grant a remote engine anything the seat routing would not.
 *
 * Devin format: { "repo_notes": [{ "content": "…" }],
 *                 "pages": [{ "title", "purpose", "parent"?, "page_notes"?: [{ "content" }] }] }
 * As in DeepWiki, a Devin `pages` list DEFINES the wiki: when it is present (and
 * `.ashlr/wiki.json` has no `include`), the built-in pages other than Overview
 * are dropped and the listed pages are generated instead.
 *
 * Bounded (64 KB per file, 40 custom pages, 100 notes, 2 KB per note) and
 * async-only: this runs inside the Verse sidecar, where a synchronous read of a
 * repo under ~/Desktop can park the thread behind a macOS privacy prompt.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const MAX_STEERING_BYTES = 64 * 1024;
const MAX_CUSTOM_PAGES = 40;
const MAX_NOTES = 100;
const MAX_NOTE_CHARS = 2000;
const MAX_LIST = 60;

export interface WikiCustomPage {
  title: string;
  purpose: string;
  parent?: string;
  notes: string[];
}

export interface WikiSteering {
  include: string[];
  exclude: string[];
  focus: string[];
  notes: string[];
  ignorePaths: string[];
  pages: WikiCustomPage[];
  maxPages?: number;
  /** The repo asked that its code never reach a remote model. */
  localOnly: boolean;
  /** True when a Devin `pages` list defines the wiki (see header). */
  devinDefinesPages: boolean;
  /** Which files contributed, repo-relative. */
  sources: string[];
  /** sha256 of the raw steering bytes; part of every page's input hash. */
  hash: string;
}

export const EMPTY_STEERING: WikiSteering = Object.freeze({
  include: [],
  exclude: [],
  focus: [],
  notes: [],
  ignorePaths: [],
  pages: [],
  localOnly: false,
  devinDefinesPages: false,
  sources: [],
  hash: 'none',
}) as WikiSteering;

async function readJsonCapped(file: string): Promise<{ raw: string; value: unknown } | null> {
  try {
    const buf = await readFile(file);
    if (buf.byteLength > MAX_STEERING_BYTES) return null;
    const raw = buf.toString('utf8');
    return { raw, value: JSON.parse(raw) as unknown };
  } catch {
    return null;
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function cleanText(v: unknown, max = MAX_NOTE_CHARS): string | null {
  if (typeof v !== 'string') return null;
  // Control characters out; these strings reach model prompts and the UI.
  // eslint-disable-next-line no-control-regex
  const t = v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  return t ? t.slice(0, max) : null;
}

function stringList(v: unknown, max = MAX_LIST): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const t = cleanText(item, 300);
    if (t) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/** Devin notes are `[{content}]`; Ashlr's are plain strings. Accept both. */
function noteList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const t = cleanText(asRecord(item)?.['content'] ?? item);
    if (t) out.push(t);
    if (out.length >= MAX_NOTES) break;
  }
  return out;
}

function pageList(v: unknown): WikiCustomPage[] {
  if (!Array.isArray(v)) return [];
  const out: WikiCustomPage[] = [];
  for (const item of v) {
    const rec = asRecord(item);
    if (!rec) continue;
    const title = cleanText(rec['title'], 120);
    if (!title) continue;
    const purpose = cleanText(rec['purpose'], 600) ?? `Explain ${title}.`;
    const parent = cleanText(rec['parent'], 120) ?? undefined;
    const notes = [...noteList(rec['page_notes']), ...noteList(rec['notes'])];
    out.push({ title, purpose, ...(parent ? { parent } : {}), notes });
    if (out.length >= MAX_CUSTOM_PAGES) break;
  }
  return out;
}

/** A path prefix from steering must stay inside the repo and be relative. */
function safePrefix(p: string): string | null {
  const norm = p.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!norm || norm.startsWith('/') || norm.split('/').includes('..')) return null;
  return norm;
}

/**
 * Read steering for `repo`. Never throws; malformed files are ignored (a broken
 * wiki.json must not stop the wiki — it just stops steering it).
 */
export async function readWikiSteering(repo: string): Promise<WikiSteering> {
  const ashlrFile = path.join(repo, '.ashlr', 'wiki.json');
  const devinFile = path.join(repo, '.devin', 'wiki.json');
  const [ashlr, devin] = await Promise.all([readJsonCapped(ashlrFile), readJsonCapped(devinFile)]);
  if (!ashlr && !devin) return EMPTY_STEERING;

  const a = asRecord(ashlr?.value) ?? {};
  const d = asRecord(devin?.value) ?? {};

  const ashlrPages = pageList(a['pages']);
  const devinPages = pageList(d['pages']);
  const include = stringList(a['include']);
  const maxPagesRaw = a['maxPages'];
  const maxPages =
    typeof maxPagesRaw === 'number' && Number.isFinite(maxPagesRaw) && maxPagesRaw >= 1
      ? Math.min(80, Math.floor(maxPagesRaw))
      : undefined;

  const hash = createHash('sha256')
    .update(ashlr?.raw ?? '')
    .update('\u0000')
    .update(devin?.raw ?? '')
    .digest('hex')
    .slice(0, 16);

  return {
    include,
    exclude: stringList(a['exclude']),
    focus: stringList(a['focus'], 12),
    notes: [...noteList(a['notes']), ...noteList(d['repo_notes'])].slice(0, MAX_NOTES),
    ignorePaths: stringList(a['ignorePaths']).map(safePrefix).filter((p): p is string => p !== null),
    pages: [...ashlrPages, ...devinPages].slice(0, MAX_CUSTOM_PAGES),
    ...(maxPages !== undefined ? { maxPages } : {}),
    localOnly: a['localOnly'] === true,
    devinDefinesPages: devinPages.length > 0 && include.length === 0 && ashlrPages.length === 0,
    sources: [...(ashlr ? ['.ashlr/wiki.json'] : []), ...(devin ? ['.devin/wiki.json'] : [])],
    hash,
  };
}
