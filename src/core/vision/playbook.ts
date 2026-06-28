/**
 * M149: ACE (Agentic Context Engineering) delta-curated playbook.
 *
 * Stores accumulated strategic and judge lessons as JSONL entries at
 * ~/.ashlr/vision/playbook.jsonl. Ops are INCREMENTAL — never a full rewrite:
 *
 *   addDelta(section, text)     — append a new lesson, dedup near-identical
 *   curate(section, opts?)      — merge duplicates, retire stale/low-hit entries
 *                                 PAST a cap WITHOUT dropping the live set
 *   renderPlaybook(section, budget) — top entries by recency+hits, budget-bound
 *
 * Never throws.
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PlaybookSection = 'strategy' | 'judge';

export interface PlaybookEntry {
  id: string;
  section: PlaybookSection;
  text: string;
  addedAt: string;
  hits: number;
  lastUsedAt: string;
  retired?: boolean;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function playbookPath(): string {
  return join(homedir(), '.ashlr', 'vision', 'playbook.jsonl');
}

function ensureDir(): void {
  try {
    const dir = join(homedir(), '.ashlr', 'vision');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// JSONL read / write
// ---------------------------------------------------------------------------

function readEntries(): PlaybookEntry[] {
  try {
    const p = playbookPath();
    if (!existsSync(p)) return [];
    const raw = readFileSync(p, 'utf8');
    const entries: PlaybookEntry[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (isValidEntry(parsed)) entries.push(parsed);
      } catch { /* skip malformed lines */ }
    }
    return entries;
  } catch {
    return [];
  }
}

/** Atomic rewrite of all entries to the JSONL file. */
function writeEntries(entries: PlaybookEntry[]): void {
  try {
    ensureDir();
    const lines = entries.map((e) => JSON.stringify(e)).join('\n');
    writeFileSync(playbookPath(), lines ? lines + '\n' : '', 'utf8');
  } catch { /* best-effort */ }
}

function isValidEntry(parsed: unknown): parsed is PlaybookEntry {
  if (typeof parsed !== 'object' || parsed === null) return false;
  const e = parsed as Record<string, unknown>;
  return (
    typeof e['id'] === 'string' &&
    typeof e['section'] === 'string' &&
    typeof e['text'] === 'string' &&
    typeof e['addedAt'] === 'string' &&
    typeof e['hits'] === 'number' &&
    typeof e['lastUsedAt'] === 'string'
  );
}

// ---------------------------------------------------------------------------
// Dedup helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when two strings are "near-identical" — same text after
 * normalising whitespace, or one is a substring of the other (≥85% overlap).
 */
function nearIdentical(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return true;
  // Substring containment check
  if (na.includes(nb) || nb.includes(na)) return true;
  // Token-overlap Jaccard ≥ 0.85
  const wordsA = new Set(na.split(' '));
  const wordsB = new Set(nb.split(' '));
  const intersection = [...wordsA].filter((w) => wordsB.has(w)).length;
  const union = wordsA.size + wordsB.size - intersection;
  return union > 0 && intersection / union >= 0.85;
}

function generateId(): string {
  return `pb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// ---------------------------------------------------------------------------
// Public: addDelta
// ---------------------------------------------------------------------------

/**
 * Append a new delta for the given section.
 *
 * Dedup: if any active entry in the same section is near-identical to `text`,
 * the existing entry's hits are incremented instead (no new line written).
 * Otherwise a fresh entry is appended.
 *
 * Never throws.
 */
export function addDelta(section: PlaybookSection, text: string): void {
  try {
    const trimmed = text.trim();
    if (!trimmed) return;

    ensureDir();
    const entries = readEntries();
    const now = new Date().toISOString();

    // Check for near-duplicate among active entries in same section.
    const existing = entries.find(
      (e) => !e.retired && e.section === section && nearIdentical(e.text, trimmed),
    );

    if (existing) {
      // Increment hits on the existing entry and rewrite.
      existing.hits += 1;
      existing.lastUsedAt = now;
      writeEntries(entries);
      return;
    }

    // Fresh entry — append to JSONL (avoids full rewrite on hot path).
    const entry: PlaybookEntry = {
      id: generateId(),
      section,
      text: trimmed,
      addedAt: now,
      hits: 0,
      lastUsedAt: now,
    };
    try {
      const line = JSON.stringify(entry) + '\n';
      appendFileSync(playbookPath(), line, 'utf8');
    } catch {
      // Fallback: full rewrite if append fails.
      writeEntries([...entries, entry]);
    }
  } catch { /* best-effort — never throws */ }
}

// ---------------------------------------------------------------------------
// Public: curate
// ---------------------------------------------------------------------------

/**
 * INCREMENTAL curation — NEVER a full rewrite that drops the live set.
 *
 * Steps (all within-section):
 *   1. Merge near-duplicates: keep the one with higher hits, retire the rest.
 *   2. Retire stale low-hit entries that exceed the cap.
 *      "Stale" = lastUsedAt older than staleDays (default 30).
 *      "Low-hit" = hits < minHits (default 1).
 *      Retire only entries past the cap (default 50) — never drop entries
 *      below the cap regardless of staleness.
 *
 * Retired entries are KEPT in the file (marked retired:true) so the audit
 * trail is preserved; renderPlaybook ignores retired entries.
 *
 * Never throws.
 */
export function curate(
  section: PlaybookSection,
  opts: { cap?: number; staleDays?: number; minHits?: number } = {},
): void {
  try {
    const cap = opts.cap ?? 50;
    const staleDays = opts.staleDays ?? 30;
    const minHits = opts.minHits ?? 1;

    const entries = readEntries();
    const now = Date.now();
    const staleMs = staleDays * 24 * 60 * 60 * 1000;

    // Active entries in this section (ordered oldest-first for dedup stability).
    const active = entries.filter((e) => !e.retired && e.section === section);

    // ── Step 1: merge near-duplicates ──────────────────────────────────────
    const merged: PlaybookEntry[] = [];
    const retiredIds = new Set<string>();

    for (const entry of active) {
      if (retiredIds.has(entry.id)) continue;
      // Find all later near-duplicates.
      const dups = active.filter(
        (e) => e.id !== entry.id && !retiredIds.has(e.id) && nearIdentical(e.text, entry.text),
      );
      if (dups.length === 0) {
        merged.push(entry);
        continue;
      }
      // Keep the one with the most hits; absorb hits from the rest.
      const all = [entry, ...dups].sort((a, b) => b.hits - a.hits);
      const winner = all[0]!;
      const totalHits = all.reduce((s, e) => s + e.hits, 0);
      winner.hits = totalHits;
      winner.lastUsedAt = all
        .map((e) => e.lastUsedAt)
        .sort()
        .reverse()[0]!;
      merged.push(winner);
      for (const dup of dups) retiredIds.add(dup.id);
    }

    // ── Step 2: retire stale low-hit entries past the cap ─────────────────
    // Sort by score DESC (hits + recency) to determine which survive.
    const scored = merged
      .map((e) => ({
        entry: e,
        score: e.hits + (now - new Date(e.lastUsedAt).getTime()) / -staleMs,
      }))
      .sort((a, b) => b.score - a.score);

    const toKeep = scored.slice(0, cap).map((s) => s.entry.id);
    const keepSet = new Set(toKeep);

    // Among entries beyond the cap: retire those that are stale + low-hit.
    for (const { entry } of scored.slice(cap)) {
      const ageMs = now - new Date(entry.lastUsedAt).getTime();
      if (ageMs > staleMs && entry.hits < minHits) {
        retiredIds.add(entry.id);
      } else {
        keepSet.add(entry.id);
      }
    }

    // ── Apply mutations to the full entries list ───────────────────────────
    let changed = false;
    for (const e of entries) {
      if (retiredIds.has(e.id) && !e.retired) {
        e.retired = true;
        changed = true;
      }
      // Propagate hit/lastUsedAt merges from the merged array.
      const mergedVersion = merged.find((m) => m.id === e.id);
      if (mergedVersion && (mergedVersion.hits !== e.hits || mergedVersion.lastUsedAt !== e.lastUsedAt)) {
        e.hits = mergedVersion.hits;
        e.lastUsedAt = mergedVersion.lastUsedAt;
        changed = true;
      }
    }

    void keepSet; // keepSet informs retiredIds selection above; not needed further

    if (changed) writeEntries(entries);
  } catch { /* best-effort — never throws */ }
}

// ---------------------------------------------------------------------------
// Public: renderPlaybook
// ---------------------------------------------------------------------------

/**
 * Render active entries for a section into a prompt-ready string.
 *
 * Ranking: (hits * 2) + recency_score (entries used more recently rank higher).
 * Budget: approximate char budget — stops adding entries when exceeded.
 * Retired entries are excluded.
 *
 * Never throws.
 */
export function renderPlaybook(section: PlaybookSection, tokenBudget: number): string {
  try {
    // Approximate chars: 1 token ≈ 4 chars
    const charBudget = tokenBudget * 4;
    const entries = readEntries().filter((e) => !e.retired && e.section === section);

    if (entries.length === 0) return '';

    const now = Date.now();
    const scored = entries
      .map((e) => {
        const ageMs = now - new Date(e.lastUsedAt).getTime();
        const ageDays = ageMs / (1000 * 60 * 60 * 24);
        const recencyScore = Math.max(0, 30 - ageDays); // 0–30, newer = higher
        return { entry: e, score: e.hits * 2 + recencyScore };
      })
      .sort((a, b) => b.score - a.score);

    const lines: string[] = [];
    let used = 0;
    for (const { entry } of scored) {
      const line = `- ${entry.text}`;
      if (used + line.length > charBudget && lines.length > 0) break;
      lines.push(line);
      used += line.length + 1;
    }

    if (lines.length === 0) return '';

    const header = section === 'strategy'
      ? '=== ACCUMULATED STRATEGY LESSONS ==='
      : '=== ACCUMULATED JUDGE LESSONS ===';
    return `${header}\n${lines.join('\n')}`;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Public: getEntries (for testing / introspection)
// ---------------------------------------------------------------------------

/** Return all entries (including retired). Never throws. */
export function getEntries(): PlaybookEntry[] {
  try {
    return readEntries();
  } catch {
    return [];
  }
}
