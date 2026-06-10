/**
 * ask.ts — Portfolio RAG: retrieve + synthesize answers from the knowledge index.
 *
 * INVARIANTS (non-negotiable):
 *  1. LOCAL-ONLY BY DEFAULT — code/chunks are NEVER sent to a cloud model unless
 *     opts.allowCloud === true AND a cloud key exists. Any code-to-cloud on the
 *     default path is a contract violation.
 *  2. READ-ONLY — this module never modifies any enrolled repo or any file
 *     outside knowledgeDir().
 *  3. ENROLLMENT-SCOPED — retrieval is limited to loadChunks() output, which
 *     itself is scoped to the persisted index (enrolled repos only).
 *  4. BOUNDED — top-K retrieval is capped; chunk text in the prompt is capped.
 *  5. NO SECRETS — chunks stored in the index are already scrubbed; we do not
 *     re-expose them beyond the local synthesis prompt.
 *  6. NEVER THROWS — degrades gracefully; returns a useful message on any failure.
 */

import type { AskResult, KnowledgeChunk } from '../types.js';
import { loadChunks } from './index.js';
import { getActiveClient } from '../run/provider-client.js';
import { loadConfig } from '../config.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of top chunks to retrieve for synthesis. */
const TOP_K = 8;

/** Max characters of a single chunk to include in the synthesis prompt. */
const CHUNK_TEXT_CAP = 600;

/** Max total characters of all chunk context in the synthesis prompt. */
const CONTEXT_TOTAL_CAP = 6000;

/** Timeout (ms) for the local Ollama /api/embeddings request. */
const EMBED_TIMEOUT_MS = 8000;

// ---------------------------------------------------------------------------
// Tokenisation (shared pattern with recall.ts — no import to avoid coupling)
// ---------------------------------------------------------------------------

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1); // drop single-char tokens
}

// ---------------------------------------------------------------------------
// Cosine similarity
// ---------------------------------------------------------------------------

function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ---------------------------------------------------------------------------
// Keyword / TF-IDF scoring for a chunk
// ---------------------------------------------------------------------------

function keywordScoreChunk(query: string, chunk: KnowledgeChunk): number {
  const queryTerms = new Set(tokenize(query));
  if (queryTerms.size === 0) return 0;

  // Weight file path tokens slightly (they indicate structural relevance)
  const fileTokens = tokenize(chunk.file);
  const textTokens = tokenize(chunk.text);

  const weightedFreq = new Map<string, number>();
  for (const t of fileTokens) {
    weightedFreq.set(t, (weightedFreq.get(t) ?? 0) + 2);
  }
  for (const t of textTokens) {
    weightedFreq.set(t, (weightedFreq.get(t) ?? 0) + 1);
  }

  if (weightedFreq.size === 0) return 0;

  let hits = 0;
  for (const term of queryTerms) {
    hits += weightedFreq.get(term) ?? 0;
  }
  return hits === 0 ? 0 : hits / queryTerms.size;
}

// ---------------------------------------------------------------------------
// Local Ollama embedding helpers (best-effort; never throw)
// ---------------------------------------------------------------------------

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
      body: JSON.stringify({ model, prompt: text.slice(0, 2000) }),
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
    if (!embedding.every((v) => typeof v === 'number')) return null;
    return embedding as number[];
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

interface Hit {
  chunk: KnowledgeChunk;
  score: number;
  method: 'embedding' | 'keyword';
}

/**
 * Retrieve the top-K most relevant chunks from the index for `question`.
 * Tries embedding cosine similarity first (local Ollama); falls back to
 * keyword/TF-IDF. Never throws; returns [] on any failure.
 */
async function retrieve(
  question: string,
  chunks: KnowledgeChunk[],
  ollamaBase: string,
): Promise<{ hits: Hit[]; method: 'embedding' | 'keyword' }> {
  if (chunks.length === 0) return { hits: [], method: 'keyword' };

  // --- Attempt embedding retrieval if any chunks have vectors ---
  const chunksWithVectors = chunks.filter((c) => c.vector && c.vector.length > 0);

  if (chunksWithVectors.length > 0) {
    // Try to get a query embedding from local Ollama
    try {
      const modelProbe = await detectEmbeddingModel(ollamaBase);
      if (modelProbe.available) {
        const queryVec = await fetchEmbedding(ollamaBase, modelProbe.model, question);
        if (queryVec !== null) {
          // Score all chunks that have vectors by cosine; keyword score for the rest
          const hits: Hit[] = chunks.map((chunk) => {
            if (chunk.vector && chunk.vector.length > 0) {
              return {
                chunk,
                score: cosine(queryVec, chunk.vector),
                method: 'embedding' as const,
              };
            }
            return {
              chunk,
              score: keywordScoreChunk(question, chunk),
              method: 'keyword' as const,
            };
          });
          hits.sort((a, b) => b.score - a.score);
          return { hits: hits.slice(0, TOP_K), method: 'embedding' };
        }
      }
    } catch {
      // Fall through to keyword
    }
  }

  // --- Keyword / TF-IDF fallback ---
  const hits: Hit[] = chunks.map((chunk) => ({
    chunk,
    score: keywordScoreChunk(question, chunk),
    method: 'keyword' as const,
  }));
  hits.sort((a, b) => b.score - a.score);
  return { hits: hits.slice(0, TOP_K), method: 'keyword' };
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function buildPrompt(question: string, hits: Hit[]): string {
  if (hits.length === 0) {
    return `Answer the following question as best you can. No source context is available.\n\nQuestion: ${question}`;
  }

  const contextParts: string[] = [];
  let totalChars = 0;

  for (const hit of hits) {
    const { chunk } = hit;
    const header = `[${chunk.repo}] ${chunk.file}:${chunk.startLine}-${chunk.endLine}`;
    const body = chunk.text.slice(0, CHUNK_TEXT_CAP);
    const entry = `${header}\n${body}`;
    if (totalChars + entry.length > CONTEXT_TOTAL_CAP) break;
    contextParts.push(entry);
    totalChars += entry.length;
  }

  return [
    'You are a software assistant with access to source code excerpts from an enrolled code portfolio.',
    'Answer the question using only the provided context. Cite the source (repo, file, line) for each claim.',
    'If the context does not contain enough information, say so clearly.',
    '',
    '--- SOURCE CONTEXT ---',
    contextParts.join('\n\n---\n'),
    '--- END CONTEXT ---',
    '',
    `Question: ${question}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Answer `question` using a local RAG pipeline over the persisted knowledge index.
 *
 * Retrieval: embedding cosine similarity (local Ollama) when vectors are present,
 * else keyword/TF-IDF. Synthesis: LOCAL model via getActiveClient (Ollama/LM Studio).
 *
 * PRIVACY GUARDRAIL: code chunks are only sent to the local synthesis model by
 * default. They are sent to a cloud model ONLY when opts.allowCloud === true AND
 * a cloud key exists (enforced by getActiveClient — it throws otherwise).
 *
 * Never throws. Degrades to an informational message when nothing is indexed
 * or the local model is unreachable.
 */
export async function ask(
  question: string,
  opts: { repo?: string; allowCloud: boolean },
): Promise<AskResult> {
  const noKnowledge = (reason: string): AskResult => ({
    question,
    answer: reason,
    sources: [],
    method: 'keyword',
    local: true,
  });

  // --- Load chunks from the persisted index ---
  let chunks: KnowledgeChunk[];
  try {
    chunks = loadChunks(opts.repo);
  } catch {
    return noKnowledge('No knowledge indexed — run `ashlr knowledge build` to index enrolled repos.');
  }

  if (chunks.length === 0) {
    const scope = opts.repo ? ` for repo ${opts.repo}` : '';
    return noKnowledge(
      `No knowledge indexed${scope} — run \`ashlr knowledge build\` to index enrolled repos.`,
    );
  }

  // --- Load config (synchronous) for Ollama base URL and provider client ---
  let cfg: ReturnType<typeof loadConfig>;
  try {
    cfg = loadConfig();
  } catch {
    return noKnowledge('Could not load ashlr config — run `ashlr` once to initialize.');
  }

  const ollamaBase = (cfg.models?.ollama ?? 'http://localhost:11434').replace(/\/+$/, '');

  // --- Retrieve top-K relevant chunks ---
  let hits: Hit[];
  let method: 'embedding' | 'keyword';
  try {
    ({ hits, method } = await retrieve(question, chunks, ollamaBase));
  } catch {
    hits = [];
    method = 'keyword';
  }

  // --- Build cited sources from retrieved hits ---
  const sources = hits.map((h) => ({
    repo: h.chunk.repo,
    file: h.chunk.file,
    line: h.chunk.startLine,
  }));

  // --- Synthesize answer via local model ---
  // PRIVACY: getActiveClient enforces LOCAL-ONLY by default.
  // allowCloud is forwarded verbatim — the client will throw if cloud is
  // selected without --allow-cloud, providing a clear error message.
  const prompt = buildPrompt(question, hits);
  let answer: string;
  let isLocal = true;

  try {
    const client = await getActiveClient(cfg, { allowCloud: opts.allowCloud });
    // ALLOWLIST (not denylist): treat ONLY the known local providers as local.
    // Any unknown/new provider id (e.g. a future 'bedrock'/'vertex') defaults to
    // local:false (cloud) so it correctly triggers the cloud warning rather than
    // being silently mislabeled as local.
    isLocal = client.id === 'ollama' || client.id === 'lmstudio';

    const result = await client.chat([
      { role: 'user', content: prompt },
    ]);
    answer = result.content.trim();
    if (!answer) {
      answer = 'The local model returned an empty response. Ensure Ollama is running with a chat model loaded.';
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Surface the local-first refusal clearly so the user knows what to do
    answer = `Could not synthesize an answer: ${msg}`;
    // If the error is a local-first refusal (no cloud without --allow-cloud),
    // treat it as a local attempt (the synthesis just failed)
    isLocal = true;
  }

  return {
    question,
    answer,
    sources,
    method,
    local: isLocal,
  };
}
