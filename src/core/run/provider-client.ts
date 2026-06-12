/**
 * provider-client.ts — thin chat client over the ACTIVE local provider.
 *
 * LOCAL-FIRST: refuses cloud providers unless --allow-cloud is passed (and the
 * relevant API key is present). Supports Ollama (/api/chat native) and LM
 * Studio (/v1/chat/completions OpenAI shape). Detects tool-call capability and
 * degrades to plain chat when unsupported.
 */

import type { AshlrConfig, ChatMessage, ChatResult, ProviderClient } from '../types.js';
import { getProviderRegistry } from '../providers.js';

// ---------------------------------------------------------------------------
// Known cloud provider identifiers
// ---------------------------------------------------------------------------

const CLOUD_PROVIDERS = new Set([
  'anthropic',
  'openai',
  'gemini',
  'cohere',
  'groq',
  'mistral',
  'azure',
]);

const CLOUD_PROVIDER_ENV: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  cohere: 'COHERE_API_KEY',
  groq: 'GROQ_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  azure: 'AZURE_OPENAI_API_KEY',
};

function isCloudProvider(id: string): boolean {
  return CLOUD_PROVIDERS.has(id.toLowerCase());
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/**
 * Approximate token count for a string (~4 chars/token heuristic).
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

// ---------------------------------------------------------------------------
// Models that reliably support tool calls via Ollama
// (additive heuristic — safe to extend; false negatives just degrade to chat)
// ---------------------------------------------------------------------------

const TOOL_CAPABLE_MODEL_PATTERNS = [
  /llama3/i,
  /llama-3/i,
  /mistral/i,
  /mixtral/i,
  /qwen/i,
  /deepseek/i,
  /command-r/i,
  /hermes/i,
  /functionary/i,
  /nexusraven/i,
  /tool/i,
];

function modelSupportsTools(modelName: string): boolean {
  return TOOL_CAPABLE_MODEL_PATTERNS.some((pat) => pat.test(modelName));
}

/**
 * Pick the best model from a list of available model names.
 * Prefers a coder/capable model, falls back to first available.
 */
function pickModel(models: string[], explicit?: string): string {
  if (models.length === 0) return explicit?.trim() || 'default';
  // 1. Explicit override. An EXPLICIT argument (passed in by a provider-aware
  //    caller such as the M15 router) takes precedence over the ASHLR_MODEL env
  //    var; the env var remains supported for the --model flag / global override.
  //    Passing the model explicitly avoids mutating shared process.env under
  //    concurrent tasks (no env race). Exact match wins, else first substring
  //    match, else trust the caller's string verbatim.
  const override = (explicit?.trim() || process.env.ASHLR_MODEL?.trim()) || undefined;
  if (override) {
    return (
      models.find((m) => m === override) ??
      models.find((m) => m.toLowerCase().includes(override.toLowerCase())) ??
      override
    );
  }
  // 2. Local-first & cost-efficient default: prefer the SMALLEST/fastest chat model so runs start
  //    instantly instead of cold-loading a 70B (which times out). Skip embedding-only models;
  //    bias slightly toward coder models among equal sizes.
  const isEmbed = (m: string) => /embed|bge|e5|nomic/i.test(m);
  const pool = models.filter((m) => !isEmbed(m));
  const ranked = (pool.length ? pool : models).slice();
  const sizeOf = (m: string): number => {
    const b = m.match(/(\d+(?:\.\d+)?)\s*b\b/i); // "3b" / "7b" / "72b"
    if (b) return parseFloat(b[1]);
    if (/mini|small|tiny|nano|phi/i.test(m)) return 3; // unlabeled small models
    return 999; // unknown size -> deprioritize
  };
  const score = (m: string): number => sizeOf(m) - (/coder|code/i.test(m) ? 0.5 : 0);
  ranked.sort((a, b) => score(a) - score(b));
  return ranked[0];
}

// ---------------------------------------------------------------------------
// Fetch with timeout
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 30_000; // 30s for chat completions

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Open a streaming connection whose AbortController stays alive AFTER the
 * response headers arrive, so the caller can keep it as an idle-watchdog
 * over the body read loop (fetchWithTimeout clears its timer the instant
 * headers resolve, leaving the body read unbounded — see the streaming loops).
 *
 * The connect timer bounds time-to-headers; the returned controller lets the
 * read loop abort a stalled/trickling body. Caller MUST clear the connect timer
 * (clearConnectTimer) once headers are in, then arm its own idle watchdog.
 */
async function fetchStream(
  url: string,
  init: RequestInit,
  connectTimeoutMs: number,
): Promise<{ response: Response; controller: AbortController; clearConnectTimer: () => void }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), connectTimeoutMs);
  let cleared = false;
  const clearConnectTimer = () => {
    if (!cleared) {
      cleared = true;
      clearTimeout(timer);
    }
  };
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return { response, controller, clearConnectTimer };
  } catch (err) {
    clearConnectTimer();
    throw err;
  }
}

/**
 * Read one chunk from a stream reader under a per-read idle deadline.
 * If no bytes arrive within idleMs, aborts the underlying request (so the
 * read rejects) and surfaces a timeout error. This bounds the ONLY otherwise
 * unbounded wait in M11: a provider that returns 200 headers then stalls
 * mid-stream (or never sends done). On timeout the caller's catch falls back
 * to non-streaming chat() (itself FETCH_TIMEOUT-bounded).
 */
async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  controller: AbortController,
  idleMs: number,
): Promise<{ done: boolean; value?: Uint8Array }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const idle = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`stream idle timeout after ${idleMs}ms`));
    }, idleMs);
  });
  try {
    return await Promise.race([reader.read(), idle]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Ollama chat client
// ---------------------------------------------------------------------------

/**
 * Parse tool calls from an Ollama response message.
 * Ollama returns tool_calls as an array on the message object.
 */
function parseOllamaToolCalls(
  message: Record<string, unknown>,
): { id: string; name: string; arguments: unknown }[] | undefined {
  const rawCalls = message['tool_calls'];
  if (!Array.isArray(rawCalls) || rawCalls.length === 0) return undefined;

  const parsed: { id: string; name: string; arguments: unknown }[] = [];
  for (const tc of rawCalls) {
    if (typeof tc !== 'object' || tc === null) continue;
    const call = tc as Record<string, unknown>;
    const fn = call['function'] as Record<string, unknown> | undefined;
    if (!fn) continue;
    const name = typeof fn['name'] === 'string' ? fn['name'] : 'unknown';
    const args = fn['arguments'] ?? {};
    // Generate a stable id from index (Ollama doesn't assign ids)
    const id = `call_${parsed.length}`;
    parsed.push({ id, name, arguments: args });
  }
  return parsed.length > 0 ? parsed : undefined;
}

/**
 * Build Ollama messages array from ChatMessage[].
 * Reused by both chat() and chatStream().
 */
function toOllamaMessages(
  messages: ChatMessage[],
): Record<string, unknown>[] {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return {
        role: 'tool' as const,
        content: m.content,
        tool_call_id: m.toolCallId,
        name: m.name,
      };
    }
    return { role: m.role, content: m.content };
  });
}

// Streaming timeout is longer — the first token may take a few seconds.
const STREAM_TIMEOUT_MS = 60_000; // 60s for streaming requests

function buildOllamaClient(
  baseUrl: string,
  model: string,
  supportsTools: boolean,
): ProviderClient {
  const chatUrl = baseUrl.replace(/\/+$/, '') + '/api/chat';

  return {
    id: 'ollama',
    supportsTools,

    async chat(messages: ChatMessage[], tools?: unknown[]): Promise<ChatResult> {
      // Map ChatMessage roles to Ollama format
      // Ollama uses role: 'system'|'user'|'assistant'|'tool'
      const ollamaMessages = toOllamaMessages(messages);

      const body: Record<string, unknown> = {
        model,
        messages: ollamaMessages,
        stream: false,
      };

      // Only send tools if supported and tools are provided
      if (supportsTools && tools && tools.length > 0) {
        body['tools'] = tools;
      }

      let response: Response;
      try {
        response = await fetchWithTimeout(chatUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Ollama fetch failed: ${msg}`);
      }

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`Ollama HTTP ${response.status}: ${errText}`);
      }

      let data: unknown;
      try {
        data = (await response.json()) as unknown;
      } catch {
        throw new Error('Ollama returned non-JSON response');
      }

      const d = data as Record<string, unknown>;
      const message = (d['message'] ?? {}) as Record<string, unknown>;
      const content =
        typeof message['content'] === 'string' ? message['content'] : '';

      // Parse usage from response
      const promptEval = typeof d['prompt_eval_count'] === 'number' ? d['prompt_eval_count'] : 0;
      const evalCount = typeof d['eval_count'] === 'number' ? d['eval_count'] : 0;

      const tokensIn =
        promptEval > 0
          ? promptEval
          : estimateTokens(messages.map((m) => m.content).join(' '));
      const tokensOut = evalCount > 0 ? evalCount : estimateTokens(content);

      const toolCalls = parseOllamaToolCalls(message);

      return {
        content,
        toolCalls,
        usage: { tokensIn, tokensOut },
      };
    },

    async chatStream(
      messages: ChatMessage[],
      tools: unknown[] | undefined,
      onDelta: (t: string) => void,
    ): Promise<ChatResult> {
      // Attempt streaming; fall back to chat() on any error.
      try {
        const ollamaMessages = toOllamaMessages(messages);

        const body: Record<string, unknown> = {
          model,
          messages: ollamaMessages,
          stream: true,
        };

        if (supportsTools && tools && tools.length > 0) {
          body['tools'] = tools;
        }

        let response: Response;
        let streamController: AbortController;
        try {
          const opened = await fetchStream(
            chatUrl,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            },
            STREAM_TIMEOUT_MS,
          );
          response = opened.response;
          streamController = opened.controller;
          // Headers are in; stop the connect timer. The read loop below arms its
          // own per-read idle watchdog via streamController so a stalled body
          // can't hang indefinitely.
          opened.clearConnectTimer();
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`Ollama stream fetch failed: ${msg}`);
        }

        if (!response.ok) {
          const errText = await response.text().catch(() => '');
          throw new Error(`Ollama stream HTTP ${response.status}: ${errText}`);
        }

        if (!response.body) {
          throw new Error('Ollama stream response has no body');
        }

        // Parse NDJSON: each line is a complete JSON object.
        // Accumulate content, tool_calls from the last message chunk, and usage
        // from the final done=true line.
        let accContent = '';
        let finalMessage: Record<string, unknown> = {};
        let tokensIn = 0;
        let tokensOut = 0;

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let lineBuffer = '';

        try {
          while (true) {
            const { done, value } = await readWithIdleTimeout(
              reader,
              streamController,
              STREAM_TIMEOUT_MS,
            );
            if (done) break;

            lineBuffer += decoder.decode(value, { stream: true });

            // Process all complete lines (delimited by '\n')
            let nlIdx: number;
            while ((nlIdx = lineBuffer.indexOf('\n')) !== -1) {
              const line = lineBuffer.slice(0, nlIdx).trim();
              lineBuffer = lineBuffer.slice(nlIdx + 1);

              if (!line) continue;

              let chunk: Record<string, unknown>;
              try {
                chunk = JSON.parse(line) as Record<string, unknown>;
              } catch {
                // Skip malformed lines
                continue;
              }

              const chunkMsg = (chunk['message'] ?? {}) as Record<string, unknown>;
              const delta =
                typeof chunkMsg['content'] === 'string' ? chunkMsg['content'] : '';

              if (delta) {
                accContent += delta;
                onDelta(delta);
              }

              // The final chunk (done:true) carries usage counters and the
              // complete message (including any tool_calls).
              if (chunk['done'] === true) {
                finalMessage = chunkMsg;

                const promptEval =
                  typeof chunk['prompt_eval_count'] === 'number'
                    ? chunk['prompt_eval_count']
                    : 0;
                const evalCount =
                  typeof chunk['eval_count'] === 'number' ? chunk['eval_count'] : 0;

                tokensIn =
                  promptEval > 0
                    ? promptEval
                    : estimateTokens(messages.map((m) => m.content).join(' '));
                tokensOut = evalCount > 0 ? evalCount : estimateTokens(accContent);
              }
            }
          }
        } finally {
          reader.releaseLock();
        }

        // Estimate usage if we never saw a done line
        if (tokensIn === 0) {
          tokensIn = estimateTokens(messages.map((m) => m.content).join(' '));
        }
        if (tokensOut === 0) {
          tokensOut = estimateTokens(accContent);
        }

        const toolCalls = parseOllamaToolCalls(finalMessage);

        return {
          content: accContent,
          toolCalls,
          usage: { tokensIn, tokensOut },
        };
      } catch {
        // Streaming failed — fall back to non-streaming chat() and emit as one delta.
        const result = await this.chat(messages, tools);
        if (result.content) {
          onDelta(result.content);
        }
        return result;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// LM Studio / OpenAI-compat client
// ---------------------------------------------------------------------------

/**
 * Parse tool calls from an OpenAI-compat response choice message.
 */
function parseOpenAIToolCalls(
  message: Record<string, unknown>,
): { id: string; name: string; arguments: unknown }[] | undefined {
  const rawCalls = message['tool_calls'];
  if (!Array.isArray(rawCalls) || rawCalls.length === 0) return undefined;

  const parsed: { id: string; name: string; arguments: unknown }[] = [];
  for (const tc of rawCalls) {
    if (typeof tc !== 'object' || tc === null) continue;
    const call = tc as Record<string, unknown>;
    const id = typeof call['id'] === 'string' ? call['id'] : `call_${parsed.length}`;
    const fn = call['function'] as Record<string, unknown> | undefined;
    if (!fn) continue;
    const name = typeof fn['name'] === 'string' ? fn['name'] : 'unknown';

    let args: unknown = fn['arguments'] ?? {};
    // Arguments may be a JSON string — parse it
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args) as unknown;
      } catch {
        // Keep as string if parse fails
      }
    }
    parsed.push({ id, name, arguments: args });
  }
  return parsed.length > 0 ? parsed : undefined;
}

/**
 * Build OpenAI-compat messages array from ChatMessage[].
 * Reused by both chat() and chatStream() in the LM Studio client.
 */
function toOpenAIMessages(
  messages: ChatMessage[],
): Record<string, unknown>[] {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return {
        role: 'tool' as const,
        content: m.content,
        tool_call_id: m.toolCallId ?? '',
        name: m.name,
      };
    }
    return { role: m.role, content: m.content };
  });
}

function buildLmStudioClient(
  baseUrl: string,
  model: string,
  supportsTools: boolean,
): ProviderClient {
  const chatUrl = baseUrl.replace(/\/+$/, '') + '/v1/chat/completions';

  return {
    id: 'lmstudio',
    supportsTools,

    async chat(messages: ChatMessage[], tools?: unknown[]): Promise<ChatResult> {
      // Map ChatMessage roles to OpenAI shape
      const openaiMessages = toOpenAIMessages(messages);

      const body: Record<string, unknown> = {
        model,
        messages: openaiMessages,
        stream: false,
      };

      if (supportsTools && tools && tools.length > 0) {
        body['tools'] = tools;
        body['tool_choice'] = 'auto';
      }

      let response: Response;
      try {
        response = await fetchWithTimeout(chatUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`LM Studio fetch failed: ${msg}`);
      }

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`LM Studio HTTP ${response.status}: ${errText}`);
      }

      let data: unknown;
      try {
        data = (await response.json()) as unknown;
      } catch {
        throw new Error('LM Studio returned non-JSON response');
      }

      const d = data as Record<string, unknown>;
      const choices = Array.isArray(d['choices']) ? d['choices'] : [];
      const firstChoice = (choices[0] ?? {}) as Record<string, unknown>;
      const message = (firstChoice['message'] ?? {}) as Record<string, unknown>;
      const content =
        typeof message['content'] === 'string' ? message['content'] : '';

      // Parse usage
      const usageRaw = (d['usage'] ?? {}) as Record<string, unknown>;
      const promptTokens =
        typeof usageRaw['prompt_tokens'] === 'number' ? usageRaw['prompt_tokens'] : 0;
      const completionTokens =
        typeof usageRaw['completion_tokens'] === 'number' ? usageRaw['completion_tokens'] : 0;

      const tokensIn =
        promptTokens > 0
          ? promptTokens
          : estimateTokens(messages.map((m) => m.content).join(' '));
      const tokensOut =
        completionTokens > 0 ? completionTokens : estimateTokens(content);

      const toolCalls = parseOpenAIToolCalls(message);

      return {
        content,
        toolCalls,
        usage: { tokensIn, tokensOut },
      };
    },

    async chatStream(
      messages: ChatMessage[],
      tools: unknown[] | undefined,
      onDelta: (t: string) => void,
    ): Promise<ChatResult> {
      // Attempt SSE streaming; fall back to chat() on any error.
      try {
        const openaiMessages = toOpenAIMessages(messages);

        const body: Record<string, unknown> = {
          model,
          messages: openaiMessages,
          stream: true,
        };

        if (supportsTools && tools && tools.length > 0) {
          body['tools'] = tools;
          body['tool_choice'] = 'auto';
        }

        let response: Response;
        let streamController: AbortController;
        try {
          const opened = await fetchStream(
            chatUrl,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            },
            STREAM_TIMEOUT_MS,
          );
          response = opened.response;
          streamController = opened.controller;
          // Headers are in; stop the connect timer. The read loop below arms its
          // own per-read idle watchdog via streamController so a stalled body
          // can't hang indefinitely.
          opened.clearConnectTimer();
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`LM Studio stream fetch failed: ${msg}`);
        }

        if (!response.ok) {
          const errText = await response.text().catch(() => '');
          throw new Error(`LM Studio stream HTTP ${response.status}: ${errText}`);
        }

        if (!response.body) {
          throw new Error('LM Studio stream response has no body');
        }

        // Parse SSE: lines prefixed with "data: "; "[DONE]" marks end.
        // Accumulate content deltas; collect tool_call fragments from the last
        // non-[DONE] chunk; extract usage from the final chunk when present.
        let accContent = '';
        // tool_calls may arrive as fragments across SSE chunks; accumulate index-keyed.
        const toolCallFragments: Record<
          number,
          { id: string; name: string; argsStr: string }
        > = {};
        let tokensIn = 0;
        let tokensOut = 0;

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let lineBuffer = '';

        try {
          while (true) {
            const { done, value } = await readWithIdleTimeout(
              reader,
              streamController,
              STREAM_TIMEOUT_MS,
            );
            if (done) break;

            lineBuffer += decoder.decode(value, { stream: true });

            let nlIdx: number;
            while ((nlIdx = lineBuffer.indexOf('\n')) !== -1) {
              const raw = lineBuffer.slice(0, nlIdx).trim();
              lineBuffer = lineBuffer.slice(nlIdx + 1);

              // SSE lines either start with "data: " or are blank/comment lines.
              if (!raw.startsWith('data:')) continue;

              const payload = raw.slice(5).trim(); // strip "data:" prefix
              if (payload === '[DONE]') continue;

              let chunk: Record<string, unknown>;
              try {
                chunk = JSON.parse(payload) as Record<string, unknown>;
              } catch {
                continue;
              }

              // Extract usage when present (some providers send on the last chunk).
              const usageRaw = chunk['usage'] as Record<string, unknown> | undefined;
              if (usageRaw) {
                const pt =
                  typeof usageRaw['prompt_tokens'] === 'number'
                    ? usageRaw['prompt_tokens']
                    : 0;
                const ct =
                  typeof usageRaw['completion_tokens'] === 'number'
                    ? usageRaw['completion_tokens']
                    : 0;
                if (pt > 0) tokensIn = pt;
                if (ct > 0) tokensOut = ct;
              }

              const choices = Array.isArray(chunk['choices']) ? chunk['choices'] : [];
              const firstChoice = (choices[0] ?? {}) as Record<string, unknown>;
              const delta = (firstChoice['delta'] ?? {}) as Record<string, unknown>;

              // Accumulate content delta
              const contentChunk =
                typeof delta['content'] === 'string' ? delta['content'] : '';
              if (contentChunk) {
                accContent += contentChunk;
                onDelta(contentChunk);
              }

              // Accumulate tool_call fragments (OpenAI streaming splits them across chunks)
              if (Array.isArray(delta['tool_calls'])) {
                for (const tc of delta['tool_calls'] as unknown[]) {
                  if (typeof tc !== 'object' || tc === null) continue;
                  const t = tc as Record<string, unknown>;
                  const idx = typeof t['index'] === 'number' ? t['index'] : 0;
                  if (!toolCallFragments[idx]) {
                    toolCallFragments[idx] = { id: '', name: '', argsStr: '' };
                  }
                  if (typeof t['id'] === 'string') {
                    toolCallFragments[idx].id = t['id'];
                  }
                  const fn = t['function'] as Record<string, unknown> | undefined;
                  if (fn) {
                    if (typeof fn['name'] === 'string') {
                      toolCallFragments[idx].name += fn['name'];
                    }
                    if (typeof fn['arguments'] === 'string') {
                      toolCallFragments[idx].argsStr += fn['arguments'];
                    }
                  }
                }
              }
            }
          }
        } finally {
          reader.releaseLock();
        }

        // Fill in usage estimates if not reported by the server
        if (tokensIn === 0) {
          tokensIn = estimateTokens(messages.map((m) => m.content).join(' '));
        }
        if (tokensOut === 0) {
          tokensOut = estimateTokens(accContent);
        }

        // Reconstruct tool calls from accumulated fragments
        const toolCalls =
          Object.keys(toolCallFragments).length > 0
            ? Object.entries(toolCallFragments).map(([, frag]) => {
                let args: unknown = frag.argsStr;
                if (frag.argsStr) {
                  try {
                    args = JSON.parse(frag.argsStr) as unknown;
                  } catch {
                    // keep as raw string if parse fails
                  }
                }
                return {
                  id: frag.id || `call_${Math.random().toString(36).slice(2)}`,
                  name: frag.name,
                  arguments: args,
                };
              })
            : undefined;

        return {
          content: accContent,
          toolCalls,
          usage: { tokensIn, tokensOut },
        };
      } catch {
        // Streaming failed — fall back to non-streaming chat() and emit as one delta.
        const result = await this.chat(messages, tools);
        if (result.content) {
          onDelta(result.content);
        }
        return result;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a chat client over the ACTIVE LOCAL provider for `cfg`.
 *
 * LOCAL-FIRST guardrail:
 *   - If the active provider is a cloud provider and !allowCloud → throws.
 *   - If allowCloud is true but the cloud provider's API key is absent → throws.
 *   - If no provider is active → throws.
 *
 * Provider detection:
 *   - 'ollama'   → POST <ollamaUrl>/api/chat  (native Ollama API)
 *   - 'lmstudio' → POST <lmstudioUrl>/v1/chat/completions  (OpenAI shape)
 *
 * Tool-call detection:
 *   - Ollama: enabled for models whose names match known tool-capable patterns.
 *   - LM Studio: enabled by default (model capability not reliably detectable
 *     without a live call; degrades gracefully on failure).
 *
 * Provider-aware routing (M15):
 *   - `opts.provider` forces a specific provider id (e.g. the cloud provider a
 *     RouteDecision escalated to) instead of defaulting to registry.activeProvider.
 *     This is REQUIRED for cloud escalation to actually target the routed cloud
 *     provider rather than silently re-running on the local active provider.
 *     The same local-first guards apply: a cloud provider id still throws unless
 *     allowCloud AND its key is present (and cloud completions are implemented).
 *   - `opts.model` forces the model name (threaded into pickModel) without
 *     mutating the shared process.env.ASHLR_MODEL — avoiding the env race under
 *     concurrent tasks. ASHLR_MODEL is still honored when opts.model is absent.
 */
export async function getActiveClient(
  cfg: AshlrConfig,
  opts: { allowCloud: boolean; provider?: string; model?: string },
): Promise<ProviderClient> {
  const registry = await getProviderRegistry(cfg);
  // Honor an explicitly-requested provider (router decision) over the chain's
  // first-up provider. This is what makes a cloud escalation actually route to
  // the cloud provider instead of falling through to the local active one.
  const activeId = opts.provider ?? registry.activeProvider;

  if (activeId === null) {
    throw new Error(
      'local-first: no provider is reachable. Start Ollama or LM Studio, or pass --allow-cloud to use a cloud provider.',
    );
  }

  // ---- Cloud-provider guard ----
  if (isCloudProvider(activeId)) {
    if (!opts.allowCloud) {
      throw new Error(
        `local-first: no local model available; the active provider is '${activeId}' (cloud). ` +
          `Pass --allow-cloud to use it.`,
      );
    }
    // allowCloud is true — verify the API key is present
    const envVar = CLOUD_PROVIDER_ENV[activeId.toLowerCase()];
    if (envVar) {
      const key = process.env[envVar];
      if (!key || key.trim().length === 0) {
        throw new Error(
          `local-first: --allow-cloud passed but ${envVar} is not set. ` +
            `Set the API key for '${activeId}' and retry.`,
        );
      }
    }
    // Cloud provider with key — not yet implemented in this client (local-first focus).
    // Throw a clear informational error rather than silently doing nothing.
    throw new Error(
      `local-first: cloud provider '${activeId}' was requested (--allow-cloud) but ` +
        `this client does not yet implement cloud completions. ` +
        `Configure Ollama or LM Studio for local inference.`,
    );
  }

  // ---- Local provider: Ollama ----
  if (activeId === 'ollama') {
    const endpoint = registry.providers.find((p) => p.id === 'ollama');
    if (!endpoint?.up) {
      throw new Error(
        `local-first: Ollama was selected as the active provider but is not reachable at ${cfg.models.ollama}. ` +
          `Ensure Ollama is running ('ollama serve').`,
      );
    }

    const model = pickModel(endpoint.models, opts.model);
    const supportsTools = modelSupportsTools(model);
    const baseUrl = cfg.models.ollama.replace(/\/+$/, '');

    return buildOllamaClient(baseUrl, model, supportsTools);
  }

  // ---- Local provider: LM Studio ----
  if (activeId === 'lmstudio') {
    const endpoint = registry.providers.find((p) => p.id === 'lmstudio');
    if (!endpoint?.up) {
      throw new Error(
        `local-first: LM Studio was selected as the active provider but is not reachable at ${cfg.models.lmstudio}. ` +
          `Ensure LM Studio is running with the local server enabled.`,
      );
    }

    const model = pickModel(endpoint.models, opts.model);
    // LM Studio (OpenAI compat) — assume tool support; degrade on error in chat()
    const supportsTools = true;
    const baseUrl = cfg.models.lmstudio.replace(/\/+$/, '');

    return buildLmStudioClient(baseUrl, model, supportsTools);
  }

  // ---- M33: plugin-contributed provider ----
  // Strictly additive: this branch is reachable ONLY when the resolved id
  // matches an enabled plugin provider — builtin routing above is untouched.
  // Cloud-tier plugin providers sit behind the SAME local-first gates as
  // builtin cloud providers (--allow-cloud + declared key env present).
  try {
    const { getPluginProviders } = await import('../plugins/registry.js');
    const pluginProviders = await getPluginProviders(cfg);
    const spec = pluginProviders.find((p) => p.id === activeId);
    if (spec) {
      if (spec.tier === 'cloud') {
        if (!opts.allowCloud) {
          throw new Error(
            `local-first: provider '${activeId}' is a cloud-tier plugin provider. Pass --allow-cloud to use it.`,
          );
        }
        for (const envKey of spec.envKeys ?? []) {
          const v = process.env[envKey];
          if (!v || v.trim().length === 0) {
            throw new Error(
              `local-first: --allow-cloud passed but ${envKey} is not set for plugin provider '${activeId}'.`,
            );
          }
        }
      }
      const client = (await spec.createClient({ model: opts.model })) as ProviderClient;
      // Runtime shape check — a plugin returning garbage must fail loudly here,
      // not deep inside the agent loop.
      if (!client || typeof client.chat !== 'function' || typeof client.id !== 'string') {
        throw new Error(`plugin provider '${activeId}' returned an invalid client (missing id/chat).`);
      }
      return client;
    }
  } catch (err) {
    // A real gate/validation error must surface; only a missing plugin layer
    // falls through to the unknown-provider error below.
    if (err instanceof Error && !err.message.includes('Cannot find module')) throw err;
  }

  // ---- Unknown local provider ----
  throw new Error(
    `local-first: unknown provider '${activeId}'. Only 'ollama', 'lmstudio', and enabled plugin providers are supported.`,
  );
}
