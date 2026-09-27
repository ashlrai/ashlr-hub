/**
 * wiki/store.ts — the private on-disk wiki: ~/.ashlr/knowledge/wiki/<key>/
 *
 *   manifest.json   WikiManifest (pages, hashes, commit, last run)
 *   pages/<id>.md   one page, secret-scrubbed markdown
 *   files.json      rel path -> line count (citation ground truth for Ask; no content)
 *   genome.json     scrubbed snapshot of the repo's genome notes (for Ask)
 *
 * Directories 0700, files 0600, atomic writes (tmp + rename). Paths resolve
 * `homedir()` at CALL time so a test's relocated HOME is honoured (the
 * 2026-08 daemon.json incident). Async only — Verse routes read this.
 */

import { createHash } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import type { WikiFileIndex, WikiManifest } from './types.js';

export interface WikiGenomeNote {
  title: string;
  text: string;
  file: string | null;
}

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_PAGE_BYTES = 512 * 1024;
const PAGE_ID_RE = /^[a-z0-9][a-z0-9-]{0,95}$/;
const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,80}-[0-9a-f]{12}$/;

export function wikiRoot(): string {
  return path.join(homedir(), '.ashlr', 'knowledge', 'wiki');
}

/** Stable, path-safe key for a repo: `<slug(basename)>-<sha256(abs)[0:12]>`. */
export function wikiKey(repo: string): string {
  const abs = path.resolve(repo);
  const slug = path.basename(abs).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+/, '').slice(0, 60) || 'repo';
  return `${slug}-${createHash('sha256').update(abs).digest('hex').slice(0, 12)}`;
}

export function isWikiKey(key: string): boolean {
  return KEY_RE.test(key);
}

export function isPageId(id: string): boolean {
  return PAGE_ID_RE.test(id);
}

function dirFor(key: string): string {
  if (!isWikiKey(key)) throw new Error('invalid wiki key');
  return path.join(wikiRoot(), key);
}

async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await chmod(dir, 0o700);
  } catch {
    // best effort (e.g. filesystems without modes)
  }
}

async function writeAtomic(file: string, content: string): Promise<void> {
  await ensurePrivateDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  await writeFile(tmp, content, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, file);
}

async function readCapped(file: string, max: number): Promise<string | null> {
  try {
    const buf = await readFile(file);
    if (buf.byteLength > max) return null;
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

function isManifest(v: unknown): v is WikiManifest {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return o['version'] === 1 && typeof o['repo'] === 'string' && typeof o['key'] === 'string' && Array.isArray(o['pages']);
}

export async function readManifest(key: string): Promise<WikiManifest | null> {
  if (!isWikiKey(key)) return null;
  const raw = await readCapped(path.join(dirFor(key), 'manifest.json'), MAX_MANIFEST_BYTES);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isManifest(parsed) && parsed.key === key ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeManifest(manifest: WikiManifest): Promise<void> {
  await writeAtomic(path.join(dirFor(manifest.key), 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function readPage(key: string, id: string): Promise<string | null> {
  if (!isWikiKey(key) || !isPageId(id)) return null;
  return readCapped(path.join(dirFor(key), 'pages', `${id}.md`), MAX_PAGE_BYTES);
}

export async function writePage(key: string, id: string, markdown: string): Promise<void> {
  if (!isPageId(id)) throw new Error('invalid page id');
  await writeAtomic(path.join(dirFor(key), 'pages', `${id}.md`), markdown);
}

export async function removePage(key: string, id: string): Promise<void> {
  if (!isWikiKey(key) || !isPageId(id)) return;
  await rm(path.join(dirFor(key), 'pages', `${id}.md`), { force: true });
}

export async function readFileIndex(key: string): Promise<WikiFileIndex> {
  if (!isWikiKey(key)) return {};
  const raw = await readCapped(path.join(dirFor(key), 'files.json'), 8 * 1024 * 1024);
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: WikiFileIndex = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if (typeof v === 'number') out[k] = v;
    return out;
  } catch {
    return {};
  }
}

export async function writeFileIndex(key: string, index: WikiFileIndex): Promise<void> {
  await writeAtomic(path.join(dirFor(key), 'files.json'), JSON.stringify(index));
}

export async function readGenomeSnapshot(key: string): Promise<WikiGenomeNote[]> {
  if (!isWikiKey(key)) return [];
  const raw = await readCapped(path.join(dirFor(key), 'genome.json'), 4 * 1024 * 1024);
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((n): n is WikiGenomeNote => typeof n === 'object' && n !== null && typeof (n as WikiGenomeNote).title === 'string' && typeof (n as WikiGenomeNote).text === 'string')
      : [];
  } catch {
    return [];
  }
}

export async function writeGenomeSnapshot(key: string, notes: readonly WikiGenomeNote[]): Promise<void> {
  await writeAtomic(path.join(dirFor(key), 'genome.json'), JSON.stringify(notes));
}

/** Every stored wiki's manifest (bounded to 200 repos). */
export async function listManifests(): Promise<WikiManifest[]> {
  let names: string[];
  try {
    names = await readdir(wikiRoot());
  } catch {
    return [];
  }
  const keys = names.filter(isWikiKey).slice(0, 200);
  const manifests = await Promise.all(keys.map((k) => readManifest(k)));
  return manifests.filter((m): m is WikiManifest => m !== null);
}
