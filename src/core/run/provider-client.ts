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
function pickModel(models: string[]): string {
  if (models.length === 0) return 'default';
  // 1. Explicit override via ASHLR_MODEL (set by the --model flag or the env). Exact match wins,
  //    else first substring match, else trust the user's string verbatim.
  const override = process.env.ASHLR_MODEL?.trim();
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
      const ollamaMessages = messages.map((m) => {
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
      const openaiMessages = messages.map((m) => {
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
 */
export async function getActiveClient(
  cfg: AshlrConfig,
  opts: { allowCloud: boolean },
): Promise<ProviderClient> {
  const registry = await getProviderRegistry(cfg);
  const activeId = registry.activeProvider;

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

    const model = pickModel(endpoint.models);
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

    const model = pickModel(endpoint.models);
    // LM Studio (OpenAI compat) — assume tool support; degrade on error in chat()
    const supportsTools = true;
    const baseUrl = cfg.models.lmstudio.replace(/\/+$/, '');

    return buildLmStudioClient(baseUrl, model, supportsTools);
  }

  // ---- Unknown local provider ----
  throw new Error(
    `local-first: unknown provider '${activeId}'. Only 'ollama' and 'lmstudio' are supported as local providers.`,
  );
}
