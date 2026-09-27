/**
 * Retro + knowledge persistence (3.15) — private state under ~/.ashlr/learn.
 *
 *   ~/.ashlr/learn/retros/<id>.json     one RetroV1 per task end (0600)
 *   ~/.ashlr/learn/knowledge.json       the review queue + approved notes (0600)
 *   ~/.ashlr/learn/knowledge-hits.jsonl append-only injection hits (0600)
 *   ~/.ashlr/learn/retro-sweep.json     last sweep time + cursors (0600)
 *
 * WHY async first: the Verse sidecar serves every route from one thread, so
 * the route reads and writes through fs/promises. The ONE synchronous reader,
 * `readApprovedKnowledgeSync`, exists for prompt builders that are themselves
 * synchronous (fleet brief assembly); it reads one small private file.
 *
 * WHY hits live in their own append-only file: the daemon records hits while
 * Verse records decisions. Two processes rewriting one JSON would lose one
 * side's write; an O_APPEND line never clobbers a decision.
 *
 * Every text field is scrubbed (secrets, home paths, emails) before it is
 * written. Directories are 0700, files 0600, writes are tmp + rename.
 * Paths re-resolve homedir() per call so tests can relocate HOME.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { scrubPrivateText } from '../../util/scrub.js';
import {
  KNOWLEDGE_NOTE_MAX_CHARS,
  RETRO_END_KINDS,
  TASK_KINDS,
  type KnowledgeNoteV1,
  type KnowledgeScope,
  type RetroV1,
  type TaskKind,
} from './types.js';

/** Retro files kept on disk; the oldest are pruned past this. */
export const MAX_RETROS = 500;
/** Notes kept in the queue file; the oldest REJECTED are pruned first. */
export const MAX_NOTES = 400;
/** The hits log is compacted once it passes this size. */
const HITS_COMPACT_BYTES = 256 * 1024;

export function learnHome(): string {
  return join(homedir(), '.ashlr', 'learn');
}
export function retrosDir(): string {
  return join(learnHome(), 'retros');
}
export function knowledgePath(): string {
  return join(learnHome(), 'knowledge.json');
}
export function knowledgeHitsPath(): string {
  return join(learnHome(), 'knowledge-hits.jsonl');
}
export function sweepStatePath(): string {
  return join(learnHome(), 'retro-sweep.json');
}

// ---------------------------------------------------------------------------
// Scrubbing + validation
// ---------------------------------------------------------------------------

/** Scrub and clamp one free-text field. Never throws. */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  let text: string;
  try {
    text = scrubPrivateText(value, { emails: true });
  } catch {
    text = value;
  }
  // eslint-disable-next-line no-control-regex -- strip C0 control characters (keep \t \n \r) from persisted text
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/[ \t]+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

const REPO_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const GLOB_PATTERN = /^[A-Za-z0-9_.*?{},/@+-]{1,160}$/;

/** Validate + normalize a scope; returns null when it is not one. */
export function normalizeScope(raw: unknown): KnowledgeScope | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const repo = r['repo'] === null || r['repo'] === undefined ? null : typeof r['repo'] === 'string' && REPO_PATTERN.test(r['repo']) ? r['repo'] : undefined;
  if (repo === undefined) return null;
  const globsRaw = r['pathGlobs'] ?? [];
  const kindsRaw = r['taskKinds'] ?? [];
  if (!Array.isArray(globsRaw) || !Array.isArray(kindsRaw) || globsRaw.length > 12 || kindsRaw.length > TASK_KINDS.length) return null;
  const pathGlobs: string[] = [];
  for (const g of globsRaw) {
    if (typeof g !== 'string') return null;
    const glob = g.trim().replace(/^\.?\//, '');
    if (!GLOB_PATTERN.test(glob) || glob.includes('..')) return null;
    if (!pathGlobs.includes(glob)) pathGlobs.push(glob);
  }
  const taskKinds: TaskKind[] = [];
  for (const k of kindsRaw) {
    if (typeof k !== 'string' || !(TASK_KINDS as readonly string[]).includes(k)) return null;
    if (!taskKinds.includes(k as TaskKind)) taskKinds.push(k as TaskKind);
  }
  return { repo, pathGlobs, taskKinds };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isRetro(raw: unknown): raw is RetroV1 {
  return isRecord(raw) && raw['v'] === 1 && typeof raw['id'] === 'string' && typeof raw['sourceKey'] === 'string'
    && typeof raw['endedAt'] === 'string' && (RETRO_END_KINDS as readonly string[]).includes(String(raw['endKind']))
    && Array.isArray(raw['candidates']) && Array.isArray(raw['doDifferently']);
}

function isNote(raw: unknown): raw is KnowledgeNoteV1 {
  return isRecord(raw) && raw['v'] === 1 && typeof raw['id'] === 'string' && typeof raw['text'] === 'string'
    && (raw['status'] === 'pending' || raw['status'] === 'approved' || raw['status'] === 'rejected')
    && normalizeScope(raw['scope']) !== null;
}

/** Retro id from its source key: one task end ⇒ one retro, however often the sweep sees it. */
export function retroIdFor(sourceKey: string): string {
  return `rt_${createHash('sha256').update(sourceKey, 'utf8').digest('hex').slice(0, 20)}`;
}

/** Note id from its normalized text + scope: the same lesson suggested twice is one note. */
export function noteIdFor(text: string, scope: KnowledgeScope): string {
  const norm = text.toLowerCase().replace(/\s+/g, ' ').trim();
  const key = `${norm}\u0000${(scope.repo ?? '').toLowerCase()}\u0000${[...scope.pathGlobs].sort().join(',')}\u0000${[...scope.taskKinds].sort().join(',')}`;
  return `kn_${createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16)}`;
}

// ---------------------------------------------------------------------------
// Low-level private I/O
// ---------------------------------------------------------------------------

async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
}

/** tmp (0600, exclusive) + rename. */
async function writePrivateJson(path: string, value: unknown, dir: string): Promise<void> {
  await ensurePrivateDir(dir);
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/**
 * In-process serialization of read-modify-write on the knowledge file: the
 * Verse server can receive two decisions at once.
 */
let knowledgeChain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = knowledgeChain.then(fn, fn);
  knowledgeChain = run.catch(() => undefined);
  return run;
}

// ---------------------------------------------------------------------------
// Retros
// ---------------------------------------------------------------------------

export async function retroExists(id: string): Promise<boolean> {
  try {
    await stat(join(retrosDir(), `${id}.json`));
    return true;
  } catch {
    return false;
  }
}

/** Persist a retro (text fields are expected to be clean already; they are scrubbed again). */
export async function saveRetro(retro: RetroV1): Promise<void> {
  const safe: RetroV1 = {
    ...retro,
    asked: cleanText(retro.asked, 600),
    happened: cleanText(retro.happened, 600),
    rootCause: retro.rootCause
      ? { ...retro.rootCause, detail: cleanText(retro.rootCause.detail, 400), label: cleanText(retro.rootCause.label, 60), evidence: cleanText(retro.rootCause.evidence, 80) }
      : null,
    doDifferently: retro.doDifferently.map((d) => cleanText(d, 300)).filter(Boolean).slice(0, 5),
    betterPrompt: retro.betterPrompt ? cleanText(retro.betterPrompt, 1200) || null : null,
    candidates: retro.candidates.map((c) => ({ ...c, text: cleanText(c.text, KNOWLEDGE_NOTE_MAX_CHARS) })).filter((c) => c.text).slice(0, 4),
  };
  await writePrivateJson(join(retrosDir(), `${safe.id}.json`), safe, retrosDir());
}

/** Newest first (by endedAt), bounded. Unreadable files are skipped. */
export async function listRetros(limit = MAX_RETROS): Promise<RetroV1[]> {
  let names: string[];
  try {
    names = (await readdir(retrosDir())).filter((n) => /^rt_[0-9a-f]{20}\.json$/.test(n));
  } catch {
    return [];
  }
  const out: RetroV1[] = [];
  for (const name of names.slice(0, MAX_RETROS * 2)) {
    const raw = await readJson(join(retrosDir(), name));
    if (isRetro(raw)) out.push(raw);
  }
  out.sort((a, b) => b.endedAt.localeCompare(a.endedAt) || a.id.localeCompare(b.id));
  return out.slice(0, limit);
}

/** Drop the oldest retros past MAX_RETROS. Best-effort. */
export async function pruneRetros(): Promise<number> {
  const all = await listRetros(MAX_RETROS * 2);
  let removed = 0;
  for (const old of all.slice(MAX_RETROS)) {
    await unlink(join(retrosDir(), `${old.id}.json`)).then(() => { removed += 1; }, () => undefined);
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Knowledge notes
// ---------------------------------------------------------------------------

interface KnowledgeFileV1 {
  v: 1;
  notes: KnowledgeNoteV1[];
}

function parseKnowledge(raw: unknown): KnowledgeNoteV1[] {
  if (!isRecord(raw) || raw['v'] !== 1 || !Array.isArray(raw['notes'])) return [];
  return raw['notes'].filter(isNote).map((n) => ({ ...n, scope: normalizeScope(n.scope)! }));
}

export async function readKnowledge(): Promise<KnowledgeNoteV1[]> {
  return parseKnowledge(await readJson(knowledgePath()));
}

/**
 * Synchronous read of the APPROVED notes, for synchronous prompt builders.
 * One small private file under ~/.ashlr/learn — never an operator folder.
 */
export function readApprovedKnowledgeSync(): KnowledgeNoteV1[] {
  try {
    return parseKnowledge(JSON.parse(readFileSync(knowledgePath(), 'utf8')) as unknown).filter((n) => n.status === 'approved');
  } catch {
    return [];
  }
}

function pruneNotes(notes: KnowledgeNoteV1[]): KnowledgeNoteV1[] {
  if (notes.length <= MAX_NOTES) return notes;
  const byAge = (a: KnowledgeNoteV1, b: KnowledgeNoteV1) => a.createdAt.localeCompare(b.createdAt);
  const rejected = notes.filter((n) => n.status === 'rejected').sort(byAge);
  const drop = new Set<string>();
  for (const n of rejected) {
    if (notes.length - drop.size <= MAX_NOTES) break;
    drop.add(n.id);
  }
  // Still over: the oldest PENDING go next. Approved notes are never pruned.
  const pending = notes.filter((n) => n.status === 'pending').sort(byAge);
  for (const n of pending) {
    if (notes.length - drop.size <= MAX_NOTES) break;
    drop.add(n.id);
  }
  return notes.filter((n) => !drop.has(n.id));
}

/** Read-modify-write of the knowledge file, serialized in-process. */
export function updateKnowledge<T>(mutate: (notes: KnowledgeNoteV1[]) => { notes: KnowledgeNoteV1[]; result: T }): Promise<T> {
  return serialized(async () => {
    const current = await readKnowledge();
    const { notes, result } = mutate(current);
    const file: KnowledgeFileV1 = { v: 1, notes: pruneNotes(notes) };
    await writePrivateJson(knowledgePath(), file, learnHome());
    return result;
  });
}

// ---------------------------------------------------------------------------
// Hits
// ---------------------------------------------------------------------------

/** Append one hit line per injected note. Fire-and-forget safe: never rejects. */
export async function recordKnowledgeHits(ids: readonly string[], at: string = new Date().toISOString()): Promise<void> {
  const clean = ids.filter((id) => /^kn_[0-9a-f]{16}$/.test(id));
  if (clean.length === 0) return;
  try {
    await ensurePrivateDir(learnHome());
    await appendFile(knowledgeHitsPath(), clean.map((id) => `${JSON.stringify({ id, at })}\n`).join(''), { encoding: 'utf8', mode: 0o600 });
    const size = (await stat(knowledgeHitsPath())).size;
    if (size > HITS_COMPACT_BYTES) await compactHits();
  } catch {
    /* a lost hit is a lost counter, never a lost lesson */
  }
}

export interface HitTotals {
  hits: number;
  lastHitAt: string | null;
}

export async function readKnowledgeHits(): Promise<Map<string, HitTotals>> {
  const out = new Map<string, HitTotals>();
  let raw: string;
  try {
    raw = await readFile(knowledgeHitsPath(), 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { id?: unknown; at?: unknown; n?: unknown };
      if (typeof row.id !== 'string' || typeof row.at !== 'string') continue;
      const n = typeof row.n === 'number' && Number.isInteger(row.n) && row.n > 0 ? row.n : 1;
      const prev = out.get(row.id) ?? { hits: 0, lastHitAt: null };
      out.set(row.id, { hits: prev.hits + n, lastHitAt: prev.lastHitAt && prev.lastHitAt > row.at ? prev.lastHitAt : row.at });
    } catch {
      /* skip a torn line */
    }
  }
  return out;
}

/** Rewrite the hits log as one summed line per note. */
async function compactHits(): Promise<void> {
  const totals = await readKnowledgeHits();
  const lines = [...totals].map(([id, t]) => JSON.stringify({ id, at: t.lastHitAt, n: t.hits })).join('\n');
  const tmp = `${knowledgeHitsPath()}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, lines ? `${lines}\n` : '', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(tmp, knowledgeHitsPath());
  } catch {
    await unlink(tmp).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Sweep state
// ---------------------------------------------------------------------------

export interface SweepStateV1 {
  v: 1;
  sweptAt: string | null;
  /** Retros created by the last sweep. */
  lastCreated: number;
  /** Model-pass calls per local day (YYYY-MM-DD), last 7 days kept. */
  modelCalls: Record<string, number>;
}

export async function readSweepState(): Promise<SweepStateV1> {
  const raw = await readJson(sweepStatePath());
  if (isRecord(raw) && raw['v'] === 1) {
    const calls: Record<string, number> = {};
    if (isRecord(raw['modelCalls'])) {
      for (const [day, n] of Object.entries(raw['modelCalls'])) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(day) && typeof n === 'number' && Number.isInteger(n) && n >= 0) calls[day] = n;
      }
    }
    return {
      v: 1,
      sweptAt: typeof raw['sweptAt'] === 'string' ? raw['sweptAt'] : null,
      lastCreated: typeof raw['lastCreated'] === 'number' ? raw['lastCreated'] : 0,
      modelCalls: calls,
    };
  }
  return { v: 1, sweptAt: null, lastCreated: 0, modelCalls: {} };
}

export async function writeSweepState(state: SweepStateV1): Promise<void> {
  await writePrivateJson(sweepStatePath(), state, learnHome());
}
