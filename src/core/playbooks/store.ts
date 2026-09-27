/**
 * Playbook persistence — private state under ~/.ashlr/playbooks.
 *
 *   ~/.ashlr/playbooks/<id>/v<N>.md   one immutable version (0600, created O_EXCL)
 *   ~/.ashlr/playbooks/index.json     createdAt + change note per version (0600)
 *   ~/.ashlr/playbooks/uses.jsonl     append-only: which run used which version
 *
 * WHY the version FILES are the source of truth and the index is only
 * metadata: a version is written with `wx` (O_EXCL), so two concurrent edits
 * can never overwrite one version — the loser gets a conflict. The index is a
 * read-modify-write file; a lost index write loses a note, never a version
 * (a version missing from the index falls back to the file's mtime).
 *
 * WHY built-ins are virtual: a machine that never edits a playbook writes
 * nothing. The first edit of a built-in persists its v1 verbatim, then v2.
 *
 * WHY uses live in their own append-only ledger instead of on the fleet
 * Proposal: a proposal is written (and signed) deep inside the sandboxed
 * engine, a Tier-1 file. The fleet records `runId → playbook@version` here at
 * dispatch; the proposal already carries that runId, so the retro sweep joins
 * the two without the proposal schema changing. Cloud and Devin tasks carry
 * `playbookRef` on their own records.
 *
 * Async first (the Verse sidecar serves every route from one thread). The
 * `*Sync` readers exist for prompt builders that are themselves synchronous
 * (fleet goal assembly); they read a handful of small private files.
 * Paths re-resolve homedir() per call so tests can relocate HOME.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { scrubSecrets } from '../util/scrub.js';
import { BUILTIN_PLAYBOOK_SOURCES } from './builtins.js';
import { canonicalizePlaybook, parsePlaybook } from './parse.js';
import {
  PLAYBOOK_ID_PATTERN,
  isPlaybookRef,
  playbookKindOf,
  type PlaybookMatch,
  type PlaybookRef,
  type PlaybookSummary,
  type PlaybookV1,
  type PlaybookValidationIssue,
  type PlaybookVersionInfo,
} from './types.js';

/** A version history is bounded; past this an edit is refused (archive and start a new id). */
export const MAX_PLAYBOOK_VERSIONS = 500;
/** Playbooks per machine. */
export const MAX_PLAYBOOKS = 200;
/** The uses ledger is compacted to its newest lines past this size. */
const USES_COMPACT_BYTES = 512 * 1024;
const USES_KEEP_LINES = 2000;
/** Stable createdAt for the virtual v1 of a built-in (the release that shipped it). */
const BUILTIN_CREATED_AT = '2026-09-27T00:00:00.000Z';

export function playbooksHome(): string {
  return join(homedir(), '.ashlr', 'playbooks');
}
function playbookDir(id: string): string {
  return join(playbooksHome(), id);
}
function versionPath(id: string, version: number): string {
  return join(playbookDir(id), `v${version}.md`);
}
function indexPath(): string {
  return join(playbooksHome(), 'index.json');
}
export function playbookUsesPath(): string {
  return join(playbooksHome(), 'uses.jsonl');
}

export function shaOf(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex').slice(0, 12);
}

// ---------------------------------------------------------------------------
// Built-ins
// ---------------------------------------------------------------------------

let builtinCache: Map<string, PlaybookV1> | null = null;

/** Built-in v1s, canonicalized once. A malformed built-in is a bug: it is skipped, never thrown. */
export function builtinPlaybooks(): Map<string, PlaybookV1> {
  if (builtinCache) return builtinCache;
  const out = new Map<string, PlaybookV1>();
  for (const raw of BUILTIN_PLAYBOOK_SOURCES) {
    const c = canonicalizePlaybook(raw);
    if (!c.ok || !c.source) continue;
    out.set(c.meta.id, {
      v: 1, meta: c.meta, sections: c.sections, version: 1, sha: shaOf(c.source),
      source: c.source, createdAt: BUILTIN_CREATED_AT, builtin: true,
    });
  }
  builtinCache = out;
  return out;
}

// ---------------------------------------------------------------------------
// Index (metadata only)
// ---------------------------------------------------------------------------

interface IndexVersion {
  version: number;
  createdAt: string;
  note: string | null;
  author?: string | null;
}

interface IndexFileV1 {
  v: 1;
  playbooks: Record<string, { versions: IndexVersion[] }>;
}

function emptyIndex(): IndexFileV1 {
  return { v: 1, playbooks: {} };
}

function normalizeIndex(raw: unknown): IndexFileV1 {
  if (!raw || typeof raw !== 'object' || (raw as { v?: unknown }).v !== 1) return emptyIndex();
  const src = (raw as { playbooks?: unknown }).playbooks;
  if (!src || typeof src !== 'object') return emptyIndex();
  const out = emptyIndex();
  for (const [id, entry] of Object.entries(src as Record<string, unknown>)) {
    if (!PLAYBOOK_ID_PATTERN.test(id) || !entry || typeof entry !== 'object') continue;
    const versions = (entry as { versions?: unknown }).versions;
    if (!Array.isArray(versions)) continue;
    out.playbooks[id] = {
      versions: versions.filter((v): v is IndexVersion =>
        !!v && typeof v === 'object'
        && Number.isInteger((v as { version?: unknown }).version)
        && typeof (v as { createdAt?: unknown }).createdAt === 'string'),
    };
  }
  return out;
}

async function readIndex(): Promise<IndexFileV1> {
  try {
    return normalizeIndex(JSON.parse(await readFile(indexPath(), 'utf8')));
  } catch {
    return emptyIndex();
  }
}

function readIndexSync(): IndexFileV1 {
  try {
    return normalizeIndex(JSON.parse(readFileSync(indexPath(), 'utf8')));
  } catch {
    return emptyIndex();
  }
}

async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
}

/** tmp (0600, exclusive) + rename. */
async function writePrivateAtomic(path: string, text: string, dir: string): Promise<void> {
  await ensurePrivateDir(dir);
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

/** In-process serialization of saves: Verse can receive two edits at once. */
let saveChain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = saveChain.then(fn, fn);
  saveChain = run.catch(() => undefined);
  return run;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const VERSION_FILE = /^v([1-9]\d{0,5})\.md$/;

function versionsFromNames(names: readonly string[]): number[] {
  return names.map((n) => VERSION_FILE.exec(n)).filter((m): m is RegExpExecArray => !!m).map((m) => Number(m[1])).sort((a, b) => a - b);
}

function toPlaybook(id: string, version: number, text: string, createdAt: string): PlaybookV1 | null {
  const parsed = parsePlaybook(text);
  // A file whose id disagrees with its folder is not trusted as that playbook.
  if (!parsed.ok || parsed.meta.id !== id) return null;
  return { v: 1, meta: parsed.meta, sections: parsed.sections, version, sha: shaOf(text), source: text, createdAt, builtin: false };
}

function createdAtFor(index: IndexFileV1, id: string, version: number, fallback: string): string {
  return index.playbooks[id]?.versions.find((v) => v.version === version)?.createdAt ?? fallback;
}

async function diskIds(): Promise<string[]> {
  try {
    return (await readdir(playbooksHome(), { withFileTypes: true }))
      .filter((d) => d.isDirectory() && PLAYBOOK_ID_PATTERN.test(d.name)).map((d) => d.name).sort();
  } catch {
    return [];
  }
}

function diskIdsSync(): string[] {
  try {
    return readdirSync(playbooksHome(), { withFileTypes: true })
      .filter((d) => d.isDirectory() && PLAYBOOK_ID_PATTERN.test(d.name)).map((d) => d.name).sort();
  } catch {
    return [];
  }
}

async function diskVersions(id: string): Promise<number[]> {
  try {
    return versionsFromNames(await readdir(playbookDir(id)));
  } catch {
    return [];
  }
}

function diskVersionsSync(id: string): number[] {
  try {
    return versionsFromNames(readdirSync(playbookDir(id)));
  } catch {
    return [];
  }
}

async function readVersionFile(id: string, version: number, index: IndexFileV1): Promise<PlaybookV1 | null> {
  try {
    const path = versionPath(id, version);
    const [text, st] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
    return toPlaybook(id, version, text, createdAtFor(index, id, version, st.mtime.toISOString()));
  } catch {
    return null;
  }
}

function readVersionFileSync(id: string, version: number, index: IndexFileV1): PlaybookV1 | null {
  try {
    const path = versionPath(id, version);
    const text = readFileSync(path, 'utf8');
    return toPlaybook(id, version, text, createdAtFor(index, id, version, statSync(path).mtime.toISOString()));
  } catch {
    return null;
  }
}

/**
 * One playbook version (latest when `version` is null). A built-in that was
 * never edited answers v1 from code. null = no such playbook / version.
 */
export async function getPlaybook(id: string, version: number | null = null): Promise<PlaybookV1 | null> {
  if (!PLAYBOOK_ID_PATTERN.test(id)) return null;
  const versions = await diskVersions(id);
  if (versions.length === 0) {
    const builtin = builtinPlaybooks().get(id) ?? null;
    return builtin && (version === null || version === 1) ? builtin : null;
  }
  const want = version ?? versions[versions.length - 1]!;
  if (!versions.includes(want)) return null;
  return readVersionFile(id, want, await readIndex());
}

/** Synchronous twin of getPlaybook, for synchronous prompt builders. Never throws. */
export function getPlaybookSync(id: string, version: number | null = null): PlaybookV1 | null {
  try {
    if (!PLAYBOOK_ID_PATTERN.test(id)) return null;
    const versions = diskVersionsSync(id);
    if (versions.length === 0) {
      const builtin = builtinPlaybooks().get(id) ?? null;
      return builtin && (version === null || version === 1) ? builtin : null;
    }
    const want = version ?? versions[versions.length - 1]!;
    if (!versions.includes(want)) return null;
    return readVersionFileSync(id, want, readIndexSync());
  } catch {
    return null;
  }
}

/** Latest version of every playbook (built-ins included), by id. */
export async function listLatestPlaybooks(): Promise<PlaybookV1[]> {
  const ids = new Set([...builtinPlaybooks().keys(), ...(await diskIds())]);
  const out: PlaybookV1[] = [];
  for (const id of [...ids].sort()) {
    const pb = await getPlaybook(id);
    if (pb) out.push(pb);
  }
  return out;
}

/** Synchronous twin of listLatestPlaybooks. Never throws. */
export function listLatestPlaybooksSync(): PlaybookV1[] {
  try {
    const ids = new Set([...builtinPlaybooks().keys(), ...diskIdsSync()]);
    const out: PlaybookV1[] = [];
    for (const id of [...ids].sort()) {
      const pb = getPlaybookSync(id);
      if (pb) out.push(pb);
    }
    return out;
  } catch {
    return [];
  }
}

export function summarizePlaybook(pb: PlaybookV1): PlaybookSummary {
  return {
    id: pb.meta.id,
    name: pb.meta.name,
    macro: pb.meta.macro,
    description: pb.meta.description,
    taskKinds: pb.meta.taskKinds,
    auto: pb.meta.auto,
    latest: pb.version,
    builtin: pb.builtin,
    updatedAt: pb.createdAt,
    kind: playbookKindOf(pb.meta),
    ...(pb.meta.kind === 'command' && pb.meta.command ? { command: pb.meta.command } : {}),
  };
}

export async function listPlaybookSummaries(): Promise<PlaybookSummary[]> {
  return (await listLatestPlaybooks()).map(summarizePlaybook);
}

/** Every version of one playbook, oldest first. [] = unknown id. */
export async function listPlaybookVersions(id: string): Promise<PlaybookVersionInfo[]> {
  if (!PLAYBOOK_ID_PATTERN.test(id)) return [];
  const versions = await diskVersions(id);
  if (versions.length === 0) {
    const b = builtinPlaybooks().get(id);
    return b ? [{ version: 1, sha: b.sha, createdAt: b.createdAt, note: 'Shipped with ashlr', author: 'ashlr' }] : [];
  }
  const index = await readIndex();
  const out: PlaybookVersionInfo[] = [];
  for (const v of versions) {
    const pb = await readVersionFile(id, v, index);
    if (!pb) continue;
    const meta = index.playbooks[id]?.versions.find((x) => x.version === v);
    out.push({ version: v, sha: pb.sha, createdAt: pb.createdAt, note: meta?.note ?? null, author: meta?.author ?? null });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Saving (create, or edit ⇒ a new immutable version)
// ---------------------------------------------------------------------------

export interface SavePlaybookOptions {
  /** The version the editor started from; a newer latest refuses the save. */
  baseVersion?: number;
  note?: string;
  /** Refuse when the id already exists (`new`). */
  createOnly?: boolean;
  /** Refuse when the id does not exist yet (`edit`). */
  editOnly?: boolean;
  /** Who is writing: `mason` (Verse), `cli`, `leader`, … Recorded per version. */
  author?: string;
  now?: () => Date;
}

export type SavePlaybookResult =
  | { ok: true; playbook: PlaybookV1; created: boolean }
  | { ok: false; errors: PlaybookValidationIssue[] };

const fail = (field: string, message: string): SavePlaybookResult => ({ ok: false, errors: [{ field, message }] });

/**
 * Validate and persist. An existing id gets version latest+1 (never a
 * rewrite); a new id gets v1. Refuses: invalid source, text that carries a
 * secret (a playbook is sent to cloud engines), a macro another playbook
 * already answers to, a stale baseVersion, and a save identical to latest.
 */
export function savePlaybook(source: string, opts: SavePlaybookOptions = {}): Promise<SavePlaybookResult> {
  return serialized(async () => {
    const c = canonicalizePlaybook(source);
    if (!c.ok || !c.source) return { ok: false, errors: c.ok ? [{ field: 'source', message: 'Could not read the playbook.' }] : c.errors };
    if (scrubSecrets(source) !== source) {
      return fail('source', 'This looks like it contains a secret (a key, token or password). Playbooks are sent to cloud engines — remove it.');
    }
    const id = c.meta.id;
    const all = await listLatestPlaybooks();
    const current = all.find((p) => p.meta.id === id) ?? null;
    if (current && opts.createOnly) return fail('id', `A playbook named \`${id}\` already exists — edit it instead.`);
    if (!current && opts.editOnly) return fail('id', `There is no playbook named \`${id}\` to edit.`);
    if (!current && all.length >= MAX_PLAYBOOKS) return fail('id', `At most ${MAX_PLAYBOOKS} playbooks.`);
    const clash = all.find((p) => p.meta.id !== id
      && (p.meta.macro === c.meta.macro || `!${p.meta.id}` === c.meta.macro || p.meta.macro === `!${id}`));
    if (clash) return fail('macro', `\`${c.meta.macro}\` is already used by the playbook \`${clash.meta.id}\`.`);
    if (current && opts.baseVersion !== undefined && opts.baseVersion !== current.version) {
      return fail('version', `This playbook changed since you opened it (now v${current.version}). Reload and re-apply your edit.`);
    }
    // A version history is one kind: an agent playbook's retros and a command
    // workflow's template must never be read as each other's versions.
    if (current && playbookKindOf(current.meta) !== playbookKindOf(c.meta)) {
      return fail('kind', `\`${id}\` is ${playbookKindOf(current.meta) === 'command' ? 'a command workflow' : 'an agent playbook'} — its kind cannot change. Save it under a new id instead.`);
    }
    if (current && current.sha === shaOf(c.source)) return fail('source', 'Nothing changed — the text matches the latest version.');
    if (current && current.version >= MAX_PLAYBOOK_VERSIONS) return fail('version', `At most ${MAX_PLAYBOOK_VERSIONS} versions per playbook.`);

    const now = (opts.now ?? (() => new Date()))().toISOString();
    const note = typeof opts.note === 'string' && opts.note.trim() ? opts.note.replace(/\s+/g, ' ').trim().slice(0, 200) : null;
    const dir = playbookDir(id);
    await ensurePrivateDir(dir);
    const index = await readIndex();
    const entry = index.playbooks[id] ?? { versions: [] };
    // First edit of a built-in: its v1 goes to disk verbatim, so history starts at what ran before.
    if (current?.builtin) {
      await writeFile(versionPath(id, 1), current.source, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      entry.versions.push({ version: 1, createdAt: current.createdAt, note: 'Shipped with ashlr', author: 'ashlr' });
    }
    const version = current ? current.version + 1 : 1;
    try {
      await writeFile(versionPath(id, version), c.source, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        return fail('version', `v${version} was just written by another editor. Reload and re-apply your edit.`);
      }
      throw err;
    }
    const author = typeof opts.author === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(opts.author) ? opts.author : null;
    entry.versions = [...entry.versions.filter((v) => v.version !== version), { version, createdAt: now, note, author }];
    index.playbooks[id] = entry;
    try {
      await writePrivateAtomic(indexPath(), `${JSON.stringify(index, null, 2)}\n`, playbooksHome());
    } catch {
      /* metadata only: the version file is already the source of truth */
    }
    const playbook: PlaybookV1 = {
      v: 1, meta: c.meta, sections: c.sections, version, sha: shaOf(c.source), source: c.source, createdAt: now, builtin: false,
    };
    return { ok: true, playbook, created: !current };
  });
}

// ---------------------------------------------------------------------------
// Uses ledger (fleet attribution)
// ---------------------------------------------------------------------------

export type PlaybookLane = 'fleet' | 'cloud' | 'devin';

export interface PlaybookUseV1 {
  v: 1;
  lane: PlaybookLane;
  /** fleet: the dispatch runId (= Proposal.runId); cloud/devin: the task id. */
  key: string;
  ref: PlaybookRef;
  match: PlaybookMatch;
  at: string;
}

const USE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

/** Append one use. Fire-and-forget safe: never throws. */
export async function recordPlaybookUse(use: Omit<PlaybookUseV1, 'v' | 'at'> & { at?: string }): Promise<void> {
  try {
    if (!USE_KEY.test(use.key) || !isPlaybookRef(use.ref)) return;
    const line: PlaybookUseV1 = {
      v: 1, lane: use.lane, key: use.key, ref: { id: use.ref.id, version: use.ref.version, sha: use.ref.sha },
      match: use.match, at: use.at ?? new Date().toISOString(),
    };
    await ensurePrivateDir(playbooksHome());
    await appendFile(playbookUsesPath(), `${JSON.stringify(line)}\n`, { encoding: 'utf8', mode: 0o600 });
    const st = await stat(playbookUsesPath());
    if (st.size > USES_COMPACT_BYTES) {
      const lines = (await readFile(playbookUsesPath(), 'utf8')).split('\n').filter(Boolean);
      await writePrivateAtomic(playbookUsesPath(), `${lines.slice(-USES_KEEP_LINES).join('\n')}\n`, playbooksHome());
    }
  } catch {
    /* a lost use is a lost attribution, never a lost run */
  }
}

/** Every recorded use, by `lane:key` (the newest wins). Unreadable ⇒ empty. */
export async function readPlaybookUses(): Promise<Map<string, PlaybookUseV1>> {
  const out = new Map<string, PlaybookUseV1>();
  let text: string;
  try {
    text = await readFile(playbookUsesPath(), 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const u = JSON.parse(line) as PlaybookUseV1;
      if (u?.v === 1 && typeof u.key === 'string' && typeof u.lane === 'string' && isPlaybookRef(u.ref)) out.set(`${u.lane}:${u.key}`, u);
    } catch {
      /* a torn line is skipped */
    }
  }
  return out;
}
