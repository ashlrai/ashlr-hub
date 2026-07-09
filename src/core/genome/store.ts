/**
 * store.ts — Genome store for M7 shared memory.
 *
 * Aggregates GenomeEntry records from two sources:
 *  (a) Per-project .ashlrcode/genome/ directories in indexed repos
 *      (manifest.json + section .md/.json files).
 *  (b) The hub store at ~/.ashlr/genome/hub.jsonl (append-only JSONL).
 *
 * GUARDRAILS:
 *  - Never throws — all I/O is wrapped defensively.
 *  - Append-only: appendHubEntry never overwrites or deletes.
 *  - Bounded: caps total entries and bytes read for perf.
 *  - Local-only: embeddings availability probed via local Ollama only.
 *  - Privacy: no secrets, no exfiltration.
 */

import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { loadIndex } from '../index-engine.js';
import type { AshlrConfig, GenomeEntry, GenomeHealth, LearnInput } from '../types.js';
import { scrubSecrets } from '../util/scrub.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max entries to read from hub.jsonl (bounded read). */
const HUB_MAX_ENTRIES = 2000;

/** Max bytes to inspect for lightweight hub health checks. */
const HUB_HEALTH_MAX_BYTES = 8 * 1024 * 1024;

/** Max bytes to read from a single section file (cap long docs). */
const SECTION_MAX_BYTES = 8000;

/** Max total entries returned from loadGenome (prevents runaway memory). */
const LOAD_MAX_TOTAL = 5000;

/** Embedding-capable model name substrings (Ollama model names). */
const EMBED_MODEL_HINTS = ['bge', 'nomic-embed', 'mxbai-embed', 'all-minilm', 'embed'];

/** Max directories to scan when walking cfg.roots for project genome dirs. */
const ROOT_SCAN_MAX_DIRS = 5000;

/** Max depth to descend under each configured root when discovering repos. */
const ROOT_SCAN_MAX_DEPTH = 4;

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Absolute path to ~/.ashlr/genome/hub.jsonl */
export function hubStorePath(): string {
  return path.join(homedir(), '.ashlr', 'genome', 'hub.jsonl');
}

/** Absolute path to ~/.ashlr/genome/ directory */
function hubStoreDir(): string {
  return path.join(homedir(), '.ashlr', 'genome');
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

/**
 * Generate a stable, URL-safe slug id from a seed string.
 * Combines a short slug (for readability) with an 8-char SHA-256 prefix
 * (for collision resistance).
 */
function makeId(seed: string): string {
  const hash = createHash('sha256').update(seed).digest('hex').slice(0, 8);
  const slug = seed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug ? `${slug}-${hash}` : hash;
}

// ---------------------------------------------------------------------------
// Safe I/O helpers
// ---------------------------------------------------------------------------

/**
 * Read up to `maxBytes` of a file. Returns null on any error or if path is
 * not a regular file.
 */
function safeReadFile(filePath: string, maxBytes = SECTION_MAX_BYTES): string | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    const size = Math.min(stat.size, maxBytes);
    if (size === 0) return '';
    const buf = Buffer.alloc(size);
    const fd = fs.openSync(filePath, 'r');
    try {
      fs.readSync(fd, buf, 0, size, 0);
    } finally {
      fs.closeSync(fd);
    }
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

/** Get file mtime as ISO string; returns `fallback` on any error. */
function safeMtime(filePath: string, fallback: string): string {
  try {
    return fs.statSync(filePath).mtime.toISOString();
  } catch {
    return fallback;
  }
}

/** JSON.parse that returns null on any error instead of throwing. */
function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function recallableHubEntryTimestamp(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const entry = value as Record<string, unknown>;
  return typeof entry['id'] === 'string' &&
    typeof entry['title'] === 'string' &&
    typeof entry['text'] === 'string' &&
    typeof entry['ts'] === 'string'
    ? entry['ts']
    : null;
}

// ---------------------------------------------------------------------------
// Project genome parsing
// ---------------------------------------------------------------------------

/**
 * Shape of one entry in manifest.json's "sections" array.
 * All fields optional — parsed defensively.
 */
interface ManifestSection {
  path?: unknown;
  title?: unknown;
  tags?: unknown;
  updatedAt?: unknown;
}

/** Extract the sections array from a parsed manifest object. */
function parseManifestSections(manifest: unknown): ManifestSection[] {
  if (typeof manifest !== 'object' || manifest === null) return [];
  const sections = (manifest as Record<string, unknown>)['sections'];
  if (!Array.isArray(sections)) return [];
  return sections as ManifestSection[];
}

/** Derive the project name from the manifest, falling back to the repo basename. */
function manifestProjectName(manifest: unknown, dirBasename: string): string {
  if (typeof manifest === 'object' && manifest !== null) {
    const p = (manifest as Record<string, unknown>)['project'];
    if (typeof p === 'string' && p.trim()) return p.trim();
  }
  return dirBasename;
}

function sanitizeGenomeEntry(entry: GenomeEntry): GenomeEntry {
  return {
    ...entry,
    id: scrubSecrets(entry.id),
    project: entry.project ? scrubSecrets(entry.project) : null,
    title: scrubSecrets(entry.title),
    text: scrubSecrets(entry.text),
    tags: entry.tags.map((tag) => scrubSecrets(tag)),
  };
}

/**
 * Load GenomeEntry records from <repo>/.ashlrcode/genome/.
 *
 * Pass 1: manifest-listed sections (path, title, tags, updatedAt).
 * Pass 2: any un-manifested .md/.json files found by walking the genome dir.
 *
 * Skips unreadable files silently. Never throws.
 */
function loadProjectGenome(repoPath: string): GenomeEntry[] {
  const genomeDir = path.join(repoPath, '.ashlrcode', 'genome');

  try {
    if (!fs.existsSync(genomeDir)) return [];
  } catch {
    return [];
  }

  const entries: GenomeEntry[] = [];
  const seenRelPaths = new Set<string>();

  // --- Parse manifest ---
  let manifest: unknown = null;
  const manifestPath = path.join(genomeDir, 'manifest.json');
  const rawManifest = safeReadFile(manifestPath, 128_000);
  if (rawManifest) manifest = safeParseJson(rawManifest);

  const projectName = manifestProjectName(manifest, path.basename(repoPath));

  // --- Pass 1: manifest-listed sections ---
  for (const sec of parseManifestSections(manifest)) {
    const relPath = typeof sec.path === 'string' ? sec.path : null;
    if (!relPath) continue;

    const absPath = path.join(genomeDir, relPath);
    const normRel = relPath.replace(/\\/g, '/');

    const title =
      typeof sec.title === 'string' && sec.title.trim()
        ? sec.title.trim()
        : path.basename(relPath, path.extname(relPath)).replace(/[-_]/g, ' ');

    const tags: string[] = Array.isArray(sec.tags)
      ? (sec.tags as unknown[])
          .filter((t): t is string => typeof t === 'string')
          .map((t) => t.trim())
          .filter(Boolean)
      : [];

    const ts =
      typeof sec.updatedAt === 'string' && sec.updatedAt
        ? sec.updatedAt
        : safeMtime(absPath, new Date().toISOString());

    const text = safeReadFile(absPath);
    if (text === null) continue; // unreadable — skip

    seenRelPaths.add(normRel);

    entries.push(sanitizeGenomeEntry({
      id: makeId(`${projectName}:${normRel}`),
      project: projectName,
      source: 'project',
      title,
      text: text.trim().slice(0, SECTION_MAX_BYTES),
      tags,
      ts,
    }));
  }

  // --- Pass 2: un-manifested .md/.json files ---
  try {
    collectGenomeFiles(genomeDir, genomeDir, projectName, seenRelPaths, entries);
  } catch {
    // Best-effort — never fail on extra files.
  }

  return entries;
}

/**
 * Recursively walk `dir` and collect .md/.json files not already in `seen`.
 * Skips manifest.json. Mutates `entries` in place.
 */
function collectGenomeFiles(
  dir: string,
  genomeRoot: string,
  projectName: string,
  seen: Set<string>,
  entries: GenomeEntry[],
): void {
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const dirent of dirents) {
    const absPath = path.join(dir, dirent.name);

    if (dirent.isDirectory()) {
      collectGenomeFiles(absPath, genomeRoot, projectName, seen, entries);
      continue;
    }

    if (!dirent.isFile()) continue;

    const ext = path.extname(dirent.name).toLowerCase();
    if (ext !== '.md' && ext !== '.json') continue;
    if (dirent.name === 'manifest.json') continue;

    const relPath = path.relative(genomeRoot, absPath).replace(/\\/g, '/');
    if (seen.has(relPath)) continue;
    seen.add(relPath);

    const text = safeReadFile(absPath);
    if (text === null || !text.trim()) continue;

    const title = path.basename(dirent.name, ext).replace(/[-_]/g, ' ');
    const ts = safeMtime(absPath, new Date().toISOString());

    entries.push(sanitizeGenomeEntry({
      id: makeId(`${projectName}:${relPath}`),
      project: projectName,
      source: 'project',
      title,
      text: text.trim().slice(0, SECTION_MAX_BYTES),
      tags: [],
      ts,
    }));
  }
}

// ---------------------------------------------------------------------------
// Hub JSONL parsing
// ---------------------------------------------------------------------------

/**
 * Parse ~/.ashlr/genome/hub.jsonl into GenomeEntry records.
 * Skips malformed or incomplete lines silently. Caps at HUB_MAX_ENTRIES.
 */
function loadHubEntries(): GenomeEntry[] {
  const storePath = hubStorePath();
  const entries: GenomeEntry[] = [];

  try {
    if (!fs.existsSync(storePath)) return [];
    const raw = fs.readFileSync(storePath, 'utf8');

    for (const line of raw.split('\n')) {
      if (entries.length >= HUB_MAX_ENTRIES) break;
      const trimmed = line.trim();
      if (!trimmed) continue;

      const parsed = safeParseJson(trimmed);
      if (typeof parsed !== 'object' || parsed === null) continue;

      const e = parsed as Record<string, unknown>;

      // All required fields must be present and correctly typed.
      if (
        typeof e['id'] !== 'string' ||
        typeof e['title'] !== 'string' ||
        typeof e['text'] !== 'string' ||
        typeof e['ts'] !== 'string'
      ) {
        continue;
      }

      entries.push(sanitizeGenomeEntry({
        id: e['id'] as string,
        project: typeof e['project'] === 'string' ? scrubSecrets(e['project']) : null,
        source: 'hub',
        title: scrubSecrets(e['title'] as string),
        text: scrubSecrets(e['text'] as string),
        tags: Array.isArray(e['tags'])
          ? (e['tags'] as unknown[])
              .filter((t): t is string => typeof t === 'string')
              .map((t) => scrubSecrets(t))
          : [],
        ts: e['ts'] as string,
      }));
    }
  } catch {
    // Any error: return whatever we parsed so far.
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Public: loadGenome
// ---------------------------------------------------------------------------

/**
 * Discover absolute paths of directories under `roots` that contain a
 * `.ashlrcode/genome/` dir. Shallow, bounded walk (depth + total-dir caps).
 * Skips noisy/heavy dirs (node_modules, .git, dist, etc.). Never throws.
 *
 * This makes loadGenome self-contained and hermetically testable: callers can
 * point cfg.roots at a fixture tree and genome dirs are found without relying
 * on a pre-built index. In real use, roots come from the user's config.
 */
function discoverGenomeRepos(roots: string[]): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  let scanned = 0;

  const SKIP_DIRS = new Set([
    'node_modules',
    '.git',
    'dist',
    'build',
    'out',
    '.next',
    '.cache',
    'coverage',
    '.venv',
    'venv',
    '__pycache__',
  ]);

  const walk = (dir: string, depth: number): void => {
    if (scanned >= ROOT_SCAN_MAX_DIRS) return;
    if (depth > ROOT_SCAN_MAX_DEPTH) return;

    // A repo is any directory that has a .ashlrcode/genome/ dir.
    try {
      const genomeDir = path.join(dir, '.ashlrcode', 'genome');
      if (fs.existsSync(genomeDir) && fs.statSync(genomeDir).isDirectory()) {
        if (!seen.has(dir)) {
          seen.add(dir);
          found.push(dir);
        }
      }
    } catch {
      // ignore — keep walking
    }

    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const dirent of dirents) {
      if (scanned >= ROOT_SCAN_MAX_DIRS) return;
      if (!dirent.isDirectory()) continue;
      if (dirent.name.startsWith('.') && dirent.name !== '.') {
        // Don't descend into dotdirs (incl. .ashlrcode itself) — but the
        // genome check above already handled the current dir.
        continue;
      }
      if (SKIP_DIRS.has(dirent.name)) continue;
      scanned++;
      walk(path.join(dir, dirent.name), depth + 1);
    }
  };

  for (const root of roots) {
    if (!root || typeof root !== 'string') continue;
    try {
      if (!fs.existsSync(root)) continue;
    } catch {
      continue;
    }
    walk(root, 0);
  }

  return found;
}

/**
 * Aggregate GenomeEntry records from all sources:
 *  (a) Each project's .ashlrcode/genome/ directory — discovered by scanning
 *      cfg.roots AND (best-effort) the pre-built index.
 *  (b) ~/.ashlr/genome/hub.jsonl
 *
 * Never throws. Bounded to LOAD_MAX_TOTAL entries total.
 * De-duplicates by entry id across sources.
 */
export function loadGenome(cfg: AshlrConfig): GenomeEntry[] {
  const entries: GenomeEntry[] = [];
  const seenIds = new Set<string>();

  // --- Source (b): hub store ---
  try {
    for (const e of loadHubEntries()) {
      if (entries.length >= LOAD_MAX_TOTAL) break;
      if (!seenIds.has(e.id)) {
        seenIds.add(e.id);
        entries.push(e);
      }
    }
  } catch {
    // Defensive — loadHubEntries already catches internally.
  }

  // --- Source (a): per-project genome dirs ---
  // Collect repo paths from two discovery mechanisms, de-duplicated:
  //   1. Scanning cfg.roots for .ashlrcode/genome/ dirs (self-contained).
  //   2. The pre-built index (real-world convenience; may be absent).
  const repoPaths = new Set<string>();
  try {
    for (const p of discoverGenomeRepos(Array.isArray(cfg.roots) ? cfg.roots : [])) {
      repoPaths.add(p);
    }
  } catch {
    // Root scan is best-effort.
  }
  try {
    const index = loadIndex();
    if (index) {
      for (const item of index.items) {
        if (item.kind === 'repo') repoPaths.add(item.path);
      }
    }
  } catch {
    // Index unavailable — continue with whatever roots gave us.
  }

  for (const repoPath of repoPaths) {
    if (entries.length >= LOAD_MAX_TOTAL) break;
    try {
      for (const e of loadProjectGenome(repoPath)) {
        if (entries.length >= LOAD_MAX_TOTAL) break;
        if (!seenIds.has(e.id)) {
          seenIds.add(e.id);
          entries.push(e);
        }
      }
    } catch {
      // One bad repo must not break the whole load.
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Public: appendHubEntry
// ---------------------------------------------------------------------------

/**
 * Append one GenomeEntry to ~/.ashlr/genome/hub.jsonl.
 *
 * GUARDRAILS:
 *  - APPEND only — never overwrites or deletes existing data.
 *  - Creates ~/.ashlr/genome/ if absent.
 *  - Optionally drops a NEW note file under the resolved project's
 *    .ashlrcode/genome/hub-notes/ — never modifies existing genome files.
 *  - Returns the written entry (source 'hub').
 */
export function appendHubEntry(input: LearnInput): GenomeEntry {
  const now = new Date().toISOString();
  const safeText = scrubSecrets(input.text).trim();

  // Derive title: supplied title, else first non-empty line of text.
  const title =
    scrubSecrets(input.title ?? '').trim() ||
    safeText
      .trim()
      .split('\n')[0]
      ?.replace(/^#+\s*/, '')
      .trim()
      .slice(0, 80) ||
    'Note';

  const project = scrubSecrets(input.project ?? '').trim() || null;
  const tags = (input.tags ?? []).map((t) => scrubSecrets(t).trim()).filter(Boolean);
  const text = safeText;

  // Id: stable slug from title + timestamp (unique per call).
  const id = makeId(`hub:${title}:${now}`);

  const entry: GenomeEntry = sanitizeGenomeEntry({
    id,
    project,
    source: 'hub',
    title,
    text,
    tags,
    ts: now,
  });

  // Ensure hub store directory exists.
  try {
    fs.mkdirSync(hubStoreDir(), { recursive: true });
  } catch {
    // Best-effort mkdir.
  }

  // Append as a single JSON line (never overwrites).
  try {
    fs.appendFileSync(hubStorePath(), JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // Append failure — still return the entry so callers can display it.
  }

  // Optionally drop a note into the resolved project's genome dir.
  // Skipped entirely when input.hubOnly is set (M16 auto-capture) so a
  // completed run/swarm never writes a file into the user's repo working tree.
  if (project && !input.hubOnly) {
    try {
      maybeWriteProjectNote(project, entry);
    } catch {
      // Best-effort only — never fail the learn operation.
    }
  }

  return entry;
}

/**
 * If `projectName` matches an indexed repo that already has a
 * .ashlrcode/genome/ directory, write a NEW note file under hub-notes/.
 * Never modifies any existing genome files.
 */
function maybeWriteProjectNote(projectName: string, entry: GenomeEntry): void {
  const index = loadIndex();
  if (!index) return;

  const lc = projectName.toLowerCase();
  const repo = index.items.find(
    (item) => item.kind === 'repo' && path.basename(item.path).toLowerCase() === lc,
  );
  if (!repo) return;

  const genomeDir = path.join(repo.path, '.ashlrcode', 'genome');
  try {
    if (!fs.existsSync(genomeDir)) return;
  } catch {
    return;
  }

  const notesDir = path.join(genomeDir, 'hub-notes');
  fs.mkdirSync(notesDir, { recursive: true });

  // Timestamp-based filename to guarantee uniqueness.
  const safeName = entry.id.slice(0, 48).replace(/[^a-z0-9-]/g, '-');
  const noteFile = path.join(notesDir, `${safeName}.md`);

  try {
    if (fs.existsSync(noteFile)) return;
  } catch {
    return;
  }

  const body =
    [
      `# ${entry.title}`,
      '',
      entry.text,
      '',
      `<!-- ashlr-learn: ${entry.ts}${entry.tags.length ? ` tags=${entry.tags.join(',')}` : ''} -->`,
    ].join('\n') + '\n';

  fs.writeFileSync(noteFile, body, 'utf8');
}

// ---------------------------------------------------------------------------
// Embeddings availability probe (synchronous)
// ---------------------------------------------------------------------------

/**
 * Synchronously probe Ollama /api/tags using `curl` via execFileSync to
 * detect whether an embedding-capable model is loaded.
 *
 * genomeHealth() is synchronous per the contract, so we use a child process
 * rather than async fetch. Best-effort — returns false on any error.
 * LOCAL ONLY — never contacts any cloud endpoint.
 */
function probeEmbeddingsSync(ollamaBase: string): boolean {
  try {
    const url = ollamaBase.replace(/\/+$/, '') + '/api/tags';
    const output = execFileSync('curl', ['-sf', '--max-time', '2', url], {
      encoding: 'utf8',
      timeout: 2500,
    });

    const body = safeParseJson(output);
    if (
      typeof body !== 'object' ||
      body === null ||
      !Array.isArray((body as Record<string, unknown>)['models'])
    ) {
      return false;
    }

    const models = (body as { models: unknown[] }).models;
    for (const m of models) {
      if (typeof m !== 'object' || m === null) continue;
      const name = (m as Record<string, unknown>)['name'];
      if (typeof name !== 'string') continue;
      if (EMBED_MODEL_HINTS.some((hint) => name.toLowerCase().includes(hint))) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public: genomeHealth
// ---------------------------------------------------------------------------

/**
 * Return a HUB-ONLY GenomeHealth roll-up read solely from the local hub store
 * (~/.ashlr/genome/hub.jsonl). UNLIKE genomeHealth(), this does NOT call
 * loadGenome()/discoverGenomeRepos() and therefore performs NO recursive
 * portfolio disk scan — it reads only the user's OWN local hub metadata.
 *
 * Used by M26 reflect to honour the "no portfolio disk scan" invariant: it
 * reports hub entry count, hub store size, and last-learned timestamp, and
 * mirrors those into totalEntries/projects (hub is the only counted source).
 *
 * Never throws.
 */
export function genomeHubHealth(): GenomeHealth {
  let hubEntries = 0;
  let sizeBytes = 0;
  let lastLearnedAt: string | null = null;

  try {
    const storePath = hubStorePath();
    if (fs.existsSync(storePath)) {
      sizeBytes = fs.statSync(storePath).size;
      const raw = safeReadFile(storePath, HUB_HEALTH_MAX_BYTES) ?? '';
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parsed = safeParseJson(trimmed);
        const ts = recallableHubEntryTimestamp(parsed);
        if (!ts) continue;
        hubEntries++;
        if (!lastLearnedAt || ts > lastLearnedAt) lastLearnedAt = ts;
      }
    }
  } catch {
    // Best-effort — leave counters at defaults.
  }

  return {
    // Hub is the only counted source here (no portfolio walk).
    totalEntries: hubEntries,
    projects: 0,
    hubEntries,
    sizeBytes,
    lastLearnedAt,
    // No network probe on the reflect path — keep it fully local + offline.
    embeddingsAvailable: false,
  };
}

/**
 * Return a GenomeHealth roll-up for the aggregated genome.
 *
 * Collects: total entries, distinct projects, hub entry count, hub store
 * size on disk, most-recent learn timestamp, and whether a local embedding
 * model is available via Ollama.
 *
 * Never throws.
 */
export function genomeHealth(cfg: AshlrConfig): GenomeHealth {
  // --- Hub store stats (direct file inspection for accuracy) ---
  let hubEntries = 0;
  let sizeBytes = 0;
  let lastLearnedAt: string | null = null;

  try {
    const storePath = hubStorePath();
    if (fs.existsSync(storePath)) {
      sizeBytes = fs.statSync(storePath).size;

      const raw = safeReadFile(storePath, HUB_HEALTH_MAX_BYTES) ?? '';
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parsed = safeParseJson(trimmed);
        const ts = recallableHubEntryTimestamp(parsed);
        if (!ts) continue;
        hubEntries++;
        if (!lastLearnedAt || ts > lastLearnedAt) {
          lastLearnedAt = ts;
        }
      }
    }
  } catch {
    // Best-effort — leave counters at defaults.
  }

  // --- Total entries + distinct projects (aggregated across all sources) ---
  let totalEntries = 0;
  const projectSet = new Set<string>();

  try {
    const allEntries = loadGenome(cfg);
    totalEntries = allEntries.length;
    for (const e of allEntries) {
      if (e.project) projectSet.add(e.project);
    }
  } catch {
    // loadGenome never throws, but guard anyway.
  }

  // --- Embeddings availability (sync probe via curl) ---
  const embeddingsAvailable = probeEmbeddingsSync(
    cfg.models?.ollama ?? 'http://localhost:11434',
  );

  return {
    totalEntries,
    projects: projectSet.size,
    hubEntries,
    sizeBytes,
    lastLearnedAt,
    embeddingsAvailable,
  };
}
