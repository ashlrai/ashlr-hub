/**
 * playbook.ts — Genome playbook synthesis (M16).
 *
 * Recalls similar past genome entries for a goal and synthesizes a concise
 * "how we've approached this before — what worked / what failed / cost"
 * string using the LOCAL provider. Falls back to a concatenated-recall
 * synthesis on any failure, over-budget condition, or absent provider.
 *
 * Guardrails:
 *  - LOCAL-ONLY: no cloud calls; synthesis uses local provider best-effort.
 *  - Never throws; always returns a Playbook.
 *  - Bounded: synthesis prompt and output are capped; playbookText hard-truncates.
 *  - PRIVACY: works only from already-sanitised recall entries (genome never
 *    stores secrets/raw payloads per M7/M16 privacy discipline).
 */

import type { AshlrConfig, Playbook, RecallHit } from '../types.js';
import { recall } from './recall.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default number of past entries to recall for the playbook. */
const DEFAULT_RECALL_LIMIT = 5;

/** Hard cap on the synthesis prompt text fed to the local model (chars). */
const SYNTHESIS_PROMPT_MAX_CHARS = 4000;

/** Hard cap on each recalled entry's text included in the prompt (chars). */
const ENTRY_TEXT_MAX_CHARS = 600;

/** Timeout (ms) for the local model synthesis call. */
const SYNTHESIS_TIMEOUT_MS = 20_000;

/** Elision marker appended when playbookText truncates. */
const ELISION = '… [truncated]';

// ---------------------------------------------------------------------------
// Fallback synthesis — pure, no I/O
// ---------------------------------------------------------------------------

/**
 * Build a concatenated-recall synthesis string from recalled entries.
 * Used when no local provider is available or the model call fails.
 * Pure; never throws.
 */
function fallbackSynthesis(goal: string, entries: RecallHit[]): string {
  if (entries.length === 0) {
    return `No past entries found for goal: "${goal}". Proceeding without historical context.`;
  }

  const lines: string[] = [`Past approaches for: "${goal}"`, ''];
  for (const hit of entries) {
    const { entry } = hit;
    const tags = entry.tags.length > 0 ? ` [${entry.tags.join(', ')}]` : '';
    const ts = entry.ts ? ` (${entry.ts.slice(0, 10)})` : '';
    const text = entry.text.slice(0, ENTRY_TEXT_MAX_CHARS);
    lines.push(`• ${entry.title}${tags}${ts}`);
    if (text) lines.push(`  ${text.replace(/\n/g, '\n  ')}`);
    lines.push('');
  }

  return lines.join('\n').trim();
}

// ---------------------------------------------------------------------------
// Prompt builder — pure, no I/O
// ---------------------------------------------------------------------------

/**
 * Build the synthesis prompt from recalled entries, capped at
 * SYNTHESIS_PROMPT_MAX_CHARS. Pure; never throws.
 */
function buildSynthesisPrompt(goal: string, entries: RecallHit[]): string {
  const header = [
    `Goal: "${goal}"`,
    '',
    'Past approaches (from genome memory):',
    '',
  ].join('\n');

  let body = '';
  for (const hit of entries) {
    const { entry } = hit;
    const tags = entry.tags.length > 0 ? ` [${entry.tags.join(', ')}]` : '';
    const ts = entry.ts ? ` (${entry.ts.slice(0, 10)})` : '';
    const text = entry.text.slice(0, ENTRY_TEXT_MAX_CHARS);
    const chunk = `### ${entry.title}${tags}${ts}\n${text}\n\n`;

    // Stop adding entries if we'd overflow the prompt cap
    if ((header + body + chunk).length > SYNTHESIS_PROMPT_MAX_CHARS) break;
    body += chunk;
  }

  const instruction = [
    'Given these past approaches to similar goals, provide a concise playbook that covers:',
    '- What worked well',
    '- What failed or caused problems',
    '- Recommended approach and any cost/time considerations',
    '',
    'Be concise (3-5 bullet points or a short paragraph). Do not repeat the entries verbatim.',
  ].join('\n');

  return `${header}${body}\n${instruction}`;
}

// ---------------------------------------------------------------------------
// Local model synthesis — best-effort, never throws
// ---------------------------------------------------------------------------

/**
 * Attempt a local model synthesis call via Ollama (POST /api/chat with
 * stream:false). Returns null on any failure or timeout.
 * LOCAL-ONLY. Never throws.
 */
async function tryLocalSynthesis(
  prompt: string,
  cfg: AshlrConfig,
): Promise<string | null> {
  try {
    const ollamaBase = (cfg.models?.ollama ?? 'http://localhost:11434').replace(/\/+$/, '');
    const chatUrl = `${ollamaBase}/api/chat`;

    // Probe for available models first — quick check, bounded timeout.
    const probeController = new AbortController();
    const probeTimer = setTimeout(() => probeController.abort(), 3000);
    let modelName: string | null = null;

    try {
      const tagsRes = await fetch(`${ollamaBase}/api/tags`, {
        signal: probeController.signal,
        headers: { Accept: 'application/json' },
      });
      if (tagsRes.ok) {
        const body = (await tagsRes.json()) as unknown;
        if (
          typeof body === 'object' &&
          body !== null &&
          Array.isArray((body as Record<string, unknown>)['models'])
        ) {
          const models = (body as { models: { name: string }[] }).models;
          // Skip embedding-only models; prefer smallest chat model.
          const isEmbed = (n: string) => /embed|bge|e5|nomic/i.test(n);
          const chatModels = models.map((m) => m.name).filter((n) => !isEmbed(n));
          if (chatModels.length > 0) {
            // Pick smallest by parameter size heuristic
            const sizeOf = (m: string): number => {
              const b = m.match(/(\d+(?:\.\d+)?)\s*b\b/i);
              if (b) return parseFloat(b[1]);
              if (/mini|small|tiny|nano|phi/i.test(m)) return 3;
              return 999;
            };
            chatModels.sort((a, b) => sizeOf(a) - sizeOf(b));
            modelName = chatModels[0];
          }
        }
      }
    } catch {
      // Probe failed — no Ollama available
    } finally {
      clearTimeout(probeTimer);
    }

    if (!modelName) return null;

    // Make the synthesis call with a bounded timeout.
    const chatController = new AbortController();
    const chatTimer = setTimeout(() => chatController.abort(), SYNTHESIS_TIMEOUT_MS);

    try {
      const res = await fetch(chatUrl, {
        method: 'POST',
        signal: chatController.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelName,
          messages: [{ role: 'user', content: prompt }],
          stream: false,
        }),
      });

      if (!res.ok) return null;

      const data = (await res.json()) as unknown;
      if (typeof data !== 'object' || data === null) return null;

      const d = data as Record<string, unknown>;
      const message = (d['message'] ?? {}) as Record<string, unknown>;
      const content = typeof message['content'] === 'string' ? message['content'] : null;

      return content && content.trim().length > 0 ? content.trim() : null;
    } catch {
      return null;
    } finally {
      clearTimeout(chatTimer);
    }
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Also try LM Studio as a fallback local provider
// ---------------------------------------------------------------------------

/**
 * Attempt synthesis via LM Studio (OpenAI-compat /v1/chat/completions).
 * Returns null on any failure. LOCAL-ONLY. Never throws.
 */
async function tryLmStudioSynthesis(
  prompt: string,
  cfg: AshlrConfig,
): Promise<string | null> {
  try {
    const lmBase = (cfg.models?.lmstudio ?? 'http://localhost:1234').replace(/\/+$/, '');
    const modelsUrl = `${lmBase}/v1/models`;
    const chatUrl = `${lmBase}/v1/chat/completions`;

    // Probe for available models.
    const probeController = new AbortController();
    const probeTimer = setTimeout(() => probeController.abort(), 3000);
    let modelName: string | null = null;

    try {
      const modelsRes = await fetch(modelsUrl, {
        signal: probeController.signal,
        headers: { Accept: 'application/json' },
      });
      if (modelsRes.ok) {
        const body = (await modelsRes.json()) as unknown;
        if (
          typeof body === 'object' &&
          body !== null &&
          Array.isArray((body as Record<string, unknown>)['data'])
        ) {
          const data = (body as { data: { id: string }[] }).data;
          if (data.length > 0 && typeof data[0].id === 'string') {
            modelName = data[0].id;
          }
        }
      }
    } catch {
      // LM Studio not available
    } finally {
      clearTimeout(probeTimer);
    }

    if (!modelName) return null;

    const chatController = new AbortController();
    const chatTimer = setTimeout(() => chatController.abort(), SYNTHESIS_TIMEOUT_MS);

    try {
      const res = await fetch(chatUrl, {
        method: 'POST',
        signal: chatController.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelName,
          messages: [{ role: 'user', content: prompt }],
          stream: false,
        }),
      });

      if (!res.ok) return null;

      const data = (await res.json()) as unknown;
      if (typeof data !== 'object' || data === null) return null;

      const d = data as Record<string, unknown>;
      const choices = Array.isArray(d['choices']) ? d['choices'] : [];
      const firstChoice = (choices[0] ?? {}) as Record<string, unknown>;
      const message = (firstChoice['message'] ?? {}) as Record<string, unknown>;
      const content = typeof message['content'] === 'string' ? message['content'] : null;

      return content && content.trim().length > 0 ? content.trim() : null;
    } catch {
      return null;
    } finally {
      clearTimeout(chatTimer);
    }
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a playbook for `goal` by recalling similar past entries and
 * synthesizing a concise guidance string via the LOCAL provider.
 *
 * Falls back to a concatenated-recall synthesis on any failure, over-budget
 * condition, or when no local provider is reachable.
 *
 * Never throws. Returns `{ goal, entries, synthesis }`.
 */
export async function buildPlaybook(
  goal: string,
  cfg: AshlrConfig,
  opts?: { limit?: number },
): Promise<Playbook> {
  // Step 1: recall similar past entries
  let entries: RecallHit[] = [];
  try {
    const limit = opts?.limit ?? cfg.genome?.maxRecall ?? DEFAULT_RECALL_LIMIT;
    entries = await recall(goal, cfg, { limit });
  } catch {
    // recall never throws per its own contract; guard defensively anyway
    entries = [];
  }

  // If no entries recalled, return immediately with a minimal playbook
  if (entries.length === 0) {
    return {
      goal,
      entries,
      synthesis: `No past entries found for goal: "${goal}". Proceeding without historical context.`,
    };
  }

  // Step 2: build the synthesis prompt
  const prompt = buildSynthesisPrompt(goal, entries);

  // Step 3: attempt local synthesis (Ollama first, then LM Studio)
  let synthesis: string | null = null;

  synthesis = await tryLocalSynthesis(prompt, cfg);

  if (!synthesis) {
    synthesis = await tryLmStudioSynthesis(prompt, cfg);
  }

  // Step 4: fall back to concatenated-recall synthesis if model unavailable/failed
  if (!synthesis) {
    synthesis = fallbackSynthesis(goal, entries);
  }

  return { goal, entries, synthesis };
}

/**
 * Render a playbook to an injection-ready string capped at `maxChars`.
 * Appends an elision marker when truncated. Pure; never throws.
 */
export function playbookText(p: Playbook, maxChars: number): string {
  if (maxChars <= 0) return '';

  const header = `=== Playbook: ${p.goal} ===\n`;
  const body = p.synthesis;
  const full = header + body;

  if (full.length <= maxChars) return full;

  // Hard truncate with elision marker
  const cutoff = maxChars - ELISION.length;
  if (cutoff <= 0) return ELISION.slice(0, maxChars);

  return full.slice(0, cutoff) + ELISION;
}
