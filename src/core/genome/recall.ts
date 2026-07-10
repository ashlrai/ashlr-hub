/**
 * recall.ts — Genome recall: keyword/TF-IDF scoring + optional Ollama embedding rerank.
 *
 * Rules:
 *  - keywordScore is pure, synchronous, deterministic; returns 0..∞ (0 = no overlap).
 *  - recall never throws; embedding rerank is best-effort, falls back to keyword silently.
 *  - Local-first: embeddings only via local Ollama /api/embeddings. Never cloud.
 *  - Offline-capable: keyword path always works without network.
 *  - Bounded: caps candidates sent to embedding reranker at EMBED_CANDIDATE_CAP.
 */

import type { AshlrConfig, GenomeEntry, RecallHit } from '../types.js';
import { loadGenome } from './store.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max candidates forwarded to embedding reranker to keep latency bounded. */
const EMBED_CANDIDATE_CAP = 20;

/** Timeout (ms) for a single Ollama /api/embeddings request. */
const EMBED_TIMEOUT_MS = 8000;

/** Minimum keyword score for an entry to be included at all (0 = include everything). */
const MIN_SCORE = 0;

// ---------------------------------------------------------------------------
// Tokenisation helpers
// ---------------------------------------------------------------------------

/**
 * Tokenise text: lowercase, split on non-alphanumeric boundaries, drop empties.
 * Returns a deduplicated term array for IDF-style calcs + a full term-count map.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

// ---------------------------------------------------------------------------
// keywordScore — pure, synchronous, deterministic
// ---------------------------------------------------------------------------

/**
 * Compute a keyword overlap score between a query and a genome entry.
 *
 * Approach: TF-style term overlap.
 *  - Tokenise the query into a unique term set.
 *  - For each query term, sum its frequency in the entry's weighted text bag:
 *      title tokens  × weight 3
 *      tag tokens    × weight 2
 *      body tokens   × weight 1
 *  - Normalise by (queryTermCount × maxPossibleHitsPerTerm) to keep roughly 0..1
 *    (may exceed 1 for very short queries with many hits — intentional).
 *
 * Returns 0 when there is no overlap at all.
 */
export function keywordScore(query: string, entry: GenomeEntry): number {
  const queryTerms = new Set(tokenize(query));
  if (queryTerms.size === 0) return 0;

  // Build a weighted token bag for the entry
  const titleTokens = tokenize(entry.title);
  const textTokens = tokenize(entry.text);
  const tagTokens = entry.tags.flatMap((tag) => tokenize(tag));

  // Weighted frequency map: title ×3, tags ×2, body ×1
  const weightedFreq = new Map<string, number>();

  for (const t of titleTokens) {
    weightedFreq.set(t, (weightedFreq.get(t) ?? 0) + 3);
  }
  for (const t of tagTokens) {
    weightedFreq.set(t, (weightedFreq.get(t) ?? 0) + 2);
  }
  for (const t of textTokens) {
    weightedFreq.set(t, (weightedFreq.get(t) ?? 0) + 1);
  }

  if (weightedFreq.size === 0) return 0;

  // Sum weighted hits for query terms
  let hits = 0;
  for (const term of queryTerms) {
    hits += weightedFreq.get(term) ?? 0;
  }

  if (hits === 0) return 0;

  // Normalise: divide by queryTermCount to get average weighted hits per query term.
  // This produces a score ≥ 0 where higher = more relevant.
  return hits / queryTerms.size;
}

// ---------------------------------------------------------------------------
// Embedding helpers — best-effort, local Ollama only
// ---------------------------------------------------------------------------

/**
 * Detect whether any embedding-capable model is available at the Ollama base URL.
 * Heuristic: look for well-known embedding model name substrings in the /api/tags list.
 * Returns { available: true, model } or { available: false }.
 * Never throws.
 */
async function detectEmbeddingModel(
  ollamaBase: string,
): Promise<{ available: false } | { available: true; model: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`${ollamaBase.replace(/\/+$/, '')}/api/tags`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return { available: false };
    const body = (await res.json()) as unknown;
    if (
      typeof body !== 'object' ||
      body === null ||
      !Array.isArray((body as Record<string, unknown>)['models'])
    ) {
      return { available: false };
    }
    const models = (body as { models: { name: string }[] }).models;
    // Prefer bge, nomic-embed, mxbai-embed, all-minilm — common local embedding models
    const EMBED_HINTS = ['bge', 'nomic-embed', 'mxbai-embed', 'all-minilm', 'embed'];
    for (const hint of EMBED_HINTS) {
      const found = models.find((m) => m.name.toLowerCase().includes(hint));
      if (found) return { available: true, model: found.name };
    }
    return { available: false };
  } catch {
    return { available: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch an embedding vector for `text` from local Ollama.
 * Uses POST /api/embeddings with { model, prompt }.
 * Returns null on any error (never throws).
 */
async function fetchEmbedding(
  ollamaBase: string,
  model: string,
  text: string,
): Promise<number[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
  try {
    const res = await fetch(`${ollamaBase.replace(/\/+$/, '')}/api/embeddings`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: text }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    if (
      typeof body !== 'object' ||
      body === null ||
      !Array.isArray((body as Record<string, unknown>)['embedding'])
    ) {
      return null;
    }
    const embedding = (body as { embedding: unknown[] }).embedding;
    // Validate: all elements must be numbers
    if (!embedding.every((v) => typeof v === 'number')) return null;
    return embedding as number[];
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Compute cosine similarity between two vectors.
 * Returns 0 on zero-length or mismatched vectors.
 */
function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

/**
 * Build a single text blob from an entry for embedding (title + tags + text).
 * Truncated to keep embedding calls bounded.
 */
function entryToEmbedText(entry: GenomeEntry): string {
  const parts = [
    entry.title,
    entry.tags.join(' '),
    entry.text,
  ].filter(Boolean);
  return parts.join(' ').slice(0, 2000);
}

/** Match the stable footprint emitted by learnFromApplied; the tag alone is untrusted. */
function isLegacyInternalSkill(entry: GenomeEntry, tags: Set<string>): boolean {
  if (!tags.has('m243:skill') || entry.source !== 'hub') return false;

  const hasEngine = entry.tags.some((tag) => /^engine:\S+$/i.test(tag.trim()));
  const hasProposal = entry.tags.some((tag) => /^proposal:\S+$/i.test(tag.trim()));
  return (
    hasEngine &&
    hasProposal &&
    entry.title.startsWith('Skill: ') &&
    entry.text.startsWith('Skill: proven workflow for "') &&
    entry.text.includes('Pattern (plan→do→verify):')
  );
}

function memoryTierMultiplier(entry: GenomeEntry): number {
  const tags = new Set(entry.tags.map((tag) => tag.trim().toLowerCase()));
  if (tags.has('m26') && tags.has('playbook')) return 1.7;
  if (isLegacyInternalSkill(entry, tags)) return 1.55;
  if (tags.has('m235:anti-playbook')) return 1.5;
  if (tags.has('reflection') || tags.has('compaction')) return 1.35;
  if (tags.has('run') || tags.has('swarm')) return 0.9;
  return 1;
}

// ---------------------------------------------------------------------------
// Main recall function
// ---------------------------------------------------------------------------

/**
 * Recall the top-k genome entries most relevant to `query`.
 *
 * 1. Load all genome entries via store.loadGenome (bounded, never throws).
 * 2. Score all entries by keyword/TF-IDF overlap.
 * 3. If opts.embeddings is true (or not explicitly false) AND an embedding
 *    model is available at the configured Ollama endpoint:
 *      a. Take up to EMBED_CANDIDATE_CAP top keyword candidates.
 *      b. Fetch embeddings for query + each candidate in parallel.
 *      c. Re-sort by cosine similarity; tag hits as method:'embedding'.
 *      d. On ANY failure, silently fall back to keyword results.
 * 4. Return top `limit` hits, sorted descending by score, with method tag.
 *
 * Never throws. Never calls cloud. Offline-capable (keyword path).
 */
export async function recall(
  query: string,
  cfg: AshlrConfig,
  opts?: { limit?: number; embeddings?: boolean },
): Promise<RecallHit[]> {
  const limit = opts?.limit ?? cfg.genome?.maxRecall ?? 5;

  // Load all entries defensively (store never throws)
  let entries: GenomeEntry[];
  try {
    entries = loadGenome(cfg);
  } catch {
    entries = [];
  }

  if (entries.length === 0 || query.trim().length === 0) return [];

  // --- Step 1: keyword scoring ---
  const keywordHits: RecallHit[] = entries
    .map((entry) => {
      const score = keywordScore(query, entry);
      return {
        entry,
        score: score > MIN_SCORE ? score * memoryTierMultiplier(entry) : score,
        method: 'keyword' as const,
      };
    })
    .filter((h) => h.score > MIN_SCORE)
    .sort((a, b) => b.score - a.score);

  // Embeddings are strictly opt-in per the contract: only rerank when the
  // caller explicitly passes embeddings:true. The default (and any non-true
  // value) returns the keyword path immediately — keeping recall offline-first,
  // deterministic, and never surfacing zero-keyword-overlap entries that an
  // embedding rerank would otherwise pull in.
  if (opts?.embeddings !== true) {
    return keywordHits.slice(0, limit);
  }

  // --- Step 2: optional embedding rerank ---
  // Take top candidates (by keyword score) for embedding reranking
  // Include all entries with positive keyword score, then pad with remaining
  // entries up to EMBED_CANDIDATE_CAP so we don't miss zero-keyword relevant entries.
  const positiveHits = keywordHits.slice(0, EMBED_CANDIDATE_CAP);
  const positiveIds = new Set(positiveHits.map((h) => h.entry.id));
  // Fill remaining slots with entries that had no keyword overlap (sorted by ts desc)
  const remaining = entries
    .filter((e) => !positiveIds.has(e.id))
    .slice(0, Math.max(0, EMBED_CANDIDATE_CAP - positiveHits.length))
    .map((entry) => ({ entry, score: 0, method: 'keyword' as const }));
  const candidates = [...positiveHits, ...remaining];

  try {
    const ollamaBase = cfg.models.ollama ?? 'http://localhost:11434';
    const modelProbe = await detectEmbeddingModel(ollamaBase);
    if (!modelProbe.available) {
      // No embedding model — return keyword results
      return keywordHits.slice(0, limit);
    }

    const { model } = modelProbe;

    // Fetch query embedding + all candidate embeddings in parallel
    const queryEmbedPromise = fetchEmbedding(ollamaBase, model, query.slice(0, 2000));
    const candidateEmbedPromises = candidates.map((h) =>
      fetchEmbedding(ollamaBase, model, entryToEmbedText(h.entry)),
    );

    const [queryVec, ...candidateVecs] = await Promise.all([
      queryEmbedPromise,
      ...candidateEmbedPromises,
    ]);

    // If query embedding failed, fall back to keyword
    if (queryVec === null) {
      return keywordHits.slice(0, limit);
    }

    // Build reranked hits; fall back per-entry to keyword score if embedding failed
    const reranked: RecallHit[] = candidates.map((hit, i) => {
      const vec = candidateVecs[i];
      if (vec === null) {
        // Embedding unavailable for this entry — keep keyword score
        return hit;
      }
      return {
        entry: hit.entry,
        score: cosine(queryVec, vec),
        method: 'embedding' as const,
      };
    });

    // Sort descending by embedding score
    reranked.sort((a, b) => b.score - a.score);
    return reranked.slice(0, limit);
  } catch {
    // Any unexpected failure: return keyword results
    return keywordHits.slice(0, limit);
  }
}
