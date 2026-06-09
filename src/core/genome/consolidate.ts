/**
 * consolidate.ts — Genome consolidation for M16.
 *
 * Merges near-duplicate hub entries (same project + normalized goal/title +
 * high token-overlap) into single canonical entries that preserve provenance:
 *   - mergedCount (how many source entries were folded in)
 *   - firstTs / lastTs (time span)
 *   - union of all tags
 *   - longest/most-informative text retained
 *
 * GUARDRAILS:
 *   - Writes a TIMESTAMPED BACKUP of hub.jsonl FIRST — no mutation before
 *     the backup succeeds.
 *   - NEVER drops information silently: merged entries retain their key content
 *     via longest-text selection + tag union.
 *   - Bounded: caps the comparison work to prevent O(n²) blow-up on huge stores.
 *   - Never throws — all I/O is wrapped defensively.
 *   - Append-only semantics preserved elsewhere; this is the ONE controlled
 *     rewrite of the hub store, and it is always backup-gated.
 */

import fs from 'node:fs';
import type { AshlrConfig, ConsolidationResult, GenomeEntry } from '../types.js';
import { hubStorePath } from './store.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of entries to load from hub.jsonl for consolidation. */
const CONSOLIDATE_MAX_ENTRIES = 2000;

/**
 * Token-overlap (Jaccard) ratio threshold above which two entries are
 * considered near-duplicates. 0.5 = 50% shared tokens.
 */
const OVERLAP_THRESHOLD = 0.5;

/**
 * Maximum number of pairwise comparisons to cap O(n²) work.
 * At 2000 entries, naïve pairs = 2M; we short-circuit at this budget.
 */
const MAX_COMPARISONS = 200_000;

// ---------------------------------------------------------------------------
// Tokenization (reuse the same approach as recall.ts for consistency)
// ---------------------------------------------------------------------------

/** Tokenize text: lowercase, split on non-alphanumeric, drop empties. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1); // drop single-char tokens to reduce noise
}

/** Build a Set of tokens from concatenated title + text for an entry. */
function entryTokenSet(entry: GenomeEntry): Set<string> {
  return new Set(tokenize(`${entry.title} ${entry.text}`));
}

/**
 * Jaccard similarity between two token sets.
 * Returns 0..1 (0 = disjoint, 1 = identical token sets).
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1; // both empty = identical
  if (a.size === 0 || b.size === 0) return 0;

  let intersectionSize = 0;
  // Iterate smaller set for efficiency
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  for (const token of smaller) {
    if (larger.has(token)) intersectionSize++;
  }
  const unionSize = a.size + b.size - intersectionSize;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a title/goal string for grouping:
 * lowercase, collapse whitespace, strip common filler words.
 */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalize project key (null → '' for grouping). */
function projectKey(project: string | null): string {
  return (project ?? '').toLowerCase().trim();
}

// ---------------------------------------------------------------------------
// Hub JSONL I/O helpers
// ---------------------------------------------------------------------------

/** JSON.parse that returns null on any error. */
function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * Result of loading hub.jsonl for consolidation.
 *
 * NO DATA LOSS: every non-empty line in the source file is accounted for in
 * EXACTLY ONE of these buckets, so the rewrite can reconstruct the full store:
 *   - `entries`: parsed, field-valid objects that participate in merging
 *     (bounded to CONSOLIDATE_MAX_ENTRIES so the O(n²) merge stays cheap).
 *   - `preservedLines`: the verbatim trimmed text of every other non-empty
 *     line — i.e. lines that failed JSON.parse, lacked required fields, or
 *     fell beyond the merge cap. These are re-emitted untouched on rewrite so
 *     consolidation NEVER removes a line it merely failed to understand or had
 *     no budget to merge.
 */
interface LoadHubRawResult {
  entries: Array<Record<string, unknown>>;
  preservedLines: string[];
}

/**
 * Load hub entries directly from hub.jsonl.
 *
 * Parses and field-validates up to CONSOLIDATE_MAX_ENTRIES objects for merging.
 * Every other non-empty line (parse failures, missing-field lines, and any
 * lines beyond the merge cap) is captured verbatim in `preservedLines` so the
 * caller can round-trip them back into the rewritten store without loss.
 */
function loadHubRaw(storePath: string): LoadHubRawResult {
  const entries: Array<Record<string, unknown>> = [];
  const preservedLines: string[] = [];
  try {
    if (!fs.existsSync(storePath)) return { entries, preservedLines };
    const raw = fs.readFileSync(storePath, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Beyond the merge cap: preserve verbatim, do NOT parse/merge.
      if (entries.length >= CONSOLIDATE_MAX_ENTRIES) {
        preservedLines.push(trimmed);
        continue;
      }

      const parsed = safeParseJson(trimmed);
      if (typeof parsed !== 'object' || parsed === null) {
        // Unparseable (or non-object) line — preserve verbatim.
        preservedLines.push(trimmed);
        continue;
      }
      const obj = parsed as Record<string, unknown>;
      // Must have minimum required fields to take part in merging.
      if (
        typeof obj['id'] !== 'string' ||
        typeof obj['title'] !== 'string' ||
        typeof obj['text'] !== 'string' ||
        typeof obj['ts'] !== 'string'
      ) {
        // Valid JSON but unknown/partial schema — preserve verbatim.
        preservedLines.push(trimmed);
        continue;
      }
      entries.push(obj);
    }
  } catch {
    // Return whatever was accumulated so far.
  }
  return { entries, preservedLines };
}

/** Cast a raw hub object to GenomeEntry (defensively). */
function rawToEntry(obj: Record<string, unknown>): GenomeEntry {
  return {
    id: obj['id'] as string,
    project: typeof obj['project'] === 'string' ? obj['project'] : null,
    source: 'hub',
    title: obj['title'] as string,
    text: obj['text'] as string,
    tags: Array.isArray(obj['tags'])
      ? (obj['tags'] as unknown[]).filter((t): t is string => typeof t === 'string')
      : [],
    ts: obj['ts'] as string,
  };
}

// ---------------------------------------------------------------------------
// Merge logic
// ---------------------------------------------------------------------------

/**
 * Extended hub entry shape that carries provenance fields written by
 * consolidation. These are persisted as extra JSON fields on the merged entry
 * so information is never lost.
 */
interface MergedHubEntry extends Record<string, unknown> {
  id: string;
  project: string | null;
  source: 'hub';
  title: string;
  text: string;
  tags: string[];
  ts: string;
  /** Number of source entries folded into this canonical entry (≥1). */
  mergedCount: number;
  /** ISO timestamp of the earliest source entry. */
  firstTs: string;
  /** ISO timestamp of the latest source entry. */
  lastTs: string;
}

/**
 * Merge a group of raw hub objects into one canonical MergedHubEntry.
 *
 * Strategy:
 *   - Canonical entry = member with the LONGEST text (most informative).
 *   - tags = union of all member tags, sorted and deduped.
 *   - firstTs = earliest ts across members.
 *   - lastTs = latest ts across members.
 *   - mergedCount = total members in this group.
 *   - id, title, project, source carried from the canonical member.
 */
function mergeGroup(group: Array<Record<string, unknown>>): MergedHubEntry {
  // Pick the longest-text member as the canonical base.
  let canonical = group[0];
  let maxLen = typeof canonical['text'] === 'string' ? canonical['text'].length : 0;
  for (let i = 1; i < group.length; i++) {
    const len = typeof group[i]['text'] === 'string' ? (group[i]['text'] as string).length : 0;
    if (len > maxLen) {
      maxLen = len;
      canonical = group[i];
    }
  }

  // Collect union tags
  const tagSet = new Set<string>();
  for (const member of group) {
    if (Array.isArray(member['tags'])) {
      for (const t of member['tags'] as unknown[]) {
        if (typeof t === 'string' && t.trim()) tagSet.add(t.trim());
      }
    }
  }

  // Collect timestamps
  const timestamps: string[] = group
    .map((m) => (typeof m['ts'] === 'string' ? (m['ts'] as string) : ''))
    .filter(Boolean)
    .sort();

  const firstTs = timestamps[0] ?? (canonical['ts'] as string);
  const lastTs = timestamps[timestamps.length - 1] ?? (canonical['ts'] as string);

  const tags = Array.from(tagSet).sort();

  return {
    // Spread all fields from canonical first so no extended fields are lost.
    ...canonical,
    // Then overwrite with our computed/merged values.
    id: canonical['id'] as string,
    project: typeof canonical['project'] === 'string' ? canonical['project'] : null,
    source: 'hub',
    title: canonical['title'] as string,
    text: canonical['text'] as string,
    tags,
    ts: lastTs, // canonical ts = most recent (for sort/display purposes)
    mergedCount: group.length,
    firstTs,
    lastTs,
  };
}

// ---------------------------------------------------------------------------
// Union-Find for grouping
// ---------------------------------------------------------------------------

/** Simple Union-Find to cluster near-duplicate entries. */
class UnionFind {
  private parent: number[];
  private rank: number[];

  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.rank = new Array(n).fill(0) as number[];
  }

  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]]; // path compression
      x = this.parent[x];
    }
    return x;
  }

  union(x: number, y: number): void {
    const rx = this.find(x);
    const ry = this.find(y);
    if (rx === ry) return;
    if (this.rank[rx] < this.rank[ry]) {
      this.parent[rx] = ry;
    } else if (this.rank[rx] > this.rank[ry]) {
      this.parent[ry] = rx;
    } else {
      this.parent[ry] = rx;
      this.rank[rx]++;
    }
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Consolidate near-duplicate entries in hub.jsonl.
 *
 * Steps:
 *   1. Read hub.jsonl entries.
 *   2. Write a timestamped backup (FIRST — before any mutation).
 *   3. Group entries: same [project × normalized-title] bucket first (cheap),
 *      then token-overlap within each bucket (Jaccard ≥ OVERLAP_THRESHOLD).
 *   4. Merge each group into a single canonical entry (longest text + union
 *      tags + provenance fields: mergedCount, firstTs, lastTs).
 *   5. Rewrite hub.jsonl with merged + un-merged entries.
 *   6. Return { before, after, merged, backupPath }.
 *
 * Returns merged:0 / before===after when nothing to merge (backup still written).
 * Never throws.
 */
export async function consolidateGenome(_cfg: AshlrConfig): Promise<ConsolidationResult> {
  const storePath = hubStorePath();
  // ISO-safe timestamp for the backup suffix (colons replaced with dashes)
  const tsSuffix = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${storePath}.bak-${tsSuffix}`;

  // Fallback result in case of early error
  const fallback = (before: number): ConsolidationResult => ({
    before,
    after: before,
    merged: 0,
    backupPath,
  });

  let rawEntries: Array<Record<string, unknown>> = [];
  let preservedLines: string[] = [];

  try {
    const loaded = loadHubRaw(storePath);
    rawEntries = loaded.entries;
    preservedLines = loaded.preservedLines;
  } catch {
    return fallback(0);
  }

  // `before` counts EVERY non-empty line in the store (mergeable entries plus
  // preserved lines), so the rewrite can never report fewer lines than existed.
  const before = rawEntries.length + preservedLines.length;

  // Step 2: Write backup FIRST before any mutation.
  // If the store doesn't exist yet, there is nothing to back up or consolidate.
  if (before === 0) {
    return { before: 0, after: 0, merged: 0, backupPath };
  }

  try {
    // Read raw bytes to preserve any lines we skipped during parsing (malformed, etc.)
    const rawBytes = fs.existsSync(storePath) ? fs.readFileSync(storePath) : Buffer.alloc(0);
    fs.writeFileSync(backupPath, rawBytes);
  } catch {
    // Cannot write backup — abort to protect NO DATA LOSS guarantee.
    return fallback(before);
  }

  // Step 3: Build groups via Union-Find.
  // Phase A: cheap bucket by [projectKey × normalizedTitle]
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < rawEntries.length; i++) {
    const entry = rawEntries[i];
    const proj = projectKey(typeof entry['project'] === 'string' ? entry['project'] : null);
    const title = normalizeTitle(typeof entry['title'] === 'string' ? (entry['title'] as string) : '');
    const bucketKey = `${proj}\x00${title}`;
    const bucket = buckets.get(bucketKey);
    if (bucket) {
      bucket.push(i);
    } else {
      buckets.set(bucketKey, [i]);
    }
  }

  // Phase B: token-overlap within each bucket (bounded comparisons)
  const uf = new UnionFind(rawEntries.length);
  // Pre-compute token sets once
  const tokenSets: Array<Set<string> | null> = rawEntries.map((obj) => {
    try {
      return entryTokenSet(rawToEntry(obj));
    } catch {
      return null;
    }
  });

  let comparisons = 0;
  for (const indices of buckets.values()) {
    if (indices.length < 2) continue; // singleton bucket — nothing to compare
    for (let a = 0; a < indices.length - 1; a++) {
      for (let b = a + 1; b < indices.length; b++) {
        if (comparisons >= MAX_COMPARISONS) break;
        comparisons++;
        const ia = indices[a];
        const ib = indices[b];
        const sa = tokenSets[ia];
        const sb = tokenSets[ib];
        if (!sa || !sb) continue;
        const sim = jaccardSimilarity(sa, sb);
        if (sim >= OVERLAP_THRESHOLD) {
          uf.union(ia, ib);
        }
      }
      if (comparisons >= MAX_COMPARISONS) break;
    }
  }

  // Step 4: Collect groups by their Union-Find root.
  const groups = new Map<number, number[]>();
  for (let i = 0; i < rawEntries.length; i++) {
    const root = uf.find(i);
    const group = groups.get(root);
    if (group) {
      group.push(i);
    } else {
      groups.set(root, [i]);
    }
  }

  // Step 5: Build output entries.
  const outputEntries: Array<Record<string, unknown>> = [];
  let mergedCount = 0;

  for (const [, memberIndices] of groups) {
    if (memberIndices.length === 1) {
      // No merge needed — preserve as-is (do NOT overwrite with MergedHubEntry shape).
      outputEntries.push(rawEntries[memberIndices[0]]);
    } else {
      // Multiple entries in this group — merge them.
      const group = memberIndices.map((i) => rawEntries[i]);
      const merged = mergeGroup(group);
      outputEntries.push(merged as unknown as Record<string, unknown>);
      // mergedCount tracks how many entries were folded AWAY (group.length - 1 survivals = 1).
      mergedCount += group.length - 1;
    }
  }

  // `after` counts the merged/unmerged entries PLUS every preserved line that
  // was carried through untouched — so the rewritten store never has fewer
  // lines than `before` minus the entries actually folded away by merging.
  const after = outputEntries.length + preservedLines.length;

  // Step 6: Rewrite hub.jsonl with merged entries.
  // Preserve insertion order (sort by ts ascending so the file is chronological).
  outputEntries.sort((a, b) => {
    const ta = typeof a['ts'] === 'string' ? (a['ts'] as string) : '';
    const tb = typeof b['ts'] === 'string' ? (b['ts'] as string) : '';
    if (ta < tb) return -1;
    if (ta > tb) return 1;
    return 0;
  });

  try {
    // Re-emit preserved (un-parseable / unknown-schema / over-cap) lines
    // verbatim so consolidation never removes a line it could not merge.
    const mergedLines = outputEntries.map((e) => JSON.stringify(e));
    const allLines = [...mergedLines, ...preservedLines];
    const lines = allLines.join('\n') + '\n';
    // Write to a temp file first, then atomically rename to avoid partial-write corruption.
    const tmpPath = `${storePath}.tmp-${tsSuffix}`;
    fs.writeFileSync(tmpPath, lines, 'utf8');
    fs.renameSync(tmpPath, storePath);
  } catch {
    // Rewrite failed — the backup is intact; hub.jsonl is unchanged (or may
    // be partially written to the temp path which is separate).
    // Return a result indicating no change so callers know consolidation didn't apply.
    return fallback(before);
  }

  return { before, after, merged: mergedCount, backupPath };
}
