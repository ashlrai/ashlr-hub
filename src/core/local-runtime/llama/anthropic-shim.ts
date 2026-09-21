/**
 * Anthropic-request normaliser for llama-server.
 *
 * WHY THIS EXISTS — measured, not assumed.
 *
 * Pointing Claude Code at llama-server's `/v1/messages` fails every turn with
 * `Jinja Exception: System message must be at the beginning`, because the CLI
 * sends `messages` with roles `['user','system']` — a system turn SECOND —
 * alongside a top-level `system` field. Qwen3.8's chat template walks
 * `messages` and refuses any system role that is not first.
 *
 * Two non-fixes were tried and rejected:
 *   - `--chat-template chatml` accepts the ordering but loses tool calling: the
 *     model narrates using a tool instead of emitting a call.
 *   - Deleting the template's assertion would be WORSE than the error. The
 *     template's system branch renders nothing (the system prompt is assembled
 *     before the loop), so a late system message would be silently dropped and
 *     the agent would lose its instructions without any failure.
 *
 * So the correct fix is upstream of the template: lift system-role turns out of
 * `messages` and fold their text into the top-level `system` block, which the
 * template consumes before the loop. No content is dropped and the order of
 * every other turn is preserved.
 */

export interface AnthropicTextBlock {
  readonly type: 'text';
  readonly text: string;
}

interface AnthropicMessageLike {
  readonly role?: unknown;
  readonly content?: unknown;
}

interface AnthropicRequestLike {
  readonly messages?: unknown;
  readonly system?: unknown;
  readonly [key: string]: unknown;
}

/** Flatten Anthropic content (string, or an array of blocks) to plain text. */
export function anthropicContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') { if (block) parts.push(block); continue; }
    if (block && typeof block === 'object') {
      const text = (block as { text?: unknown }).text;
      if (typeof text === 'string' && text) parts.push(text);
    }
  }
  return parts.join('\n');
}

function existingSystemBlocks(system: unknown): AnthropicTextBlock[] {
  if (Array.isArray(system)) {
    const out: AnthropicTextBlock[] = [];
    for (const block of system) {
      if (typeof block === 'string') { if (block) out.push({ type: 'text', text: block }); continue; }
      if (block && typeof block === 'object') {
        const text = (block as { text?: unknown }).text;
        if (typeof text === 'string' && text) out.push({ type: 'text', text });
      }
    }
    return out;
  }
  if (typeof system === 'string' && system) return [{ type: 'text', text: system }];
  return [];
}

/**
 * Hoist system-role turns into the top-level `system` field.
 *
 * Returns the body unchanged when there is nothing to lift, so a request that
 * already satisfies the template is forwarded byte-for-byte.
 */
export function normaliseAnthropicRequest<T extends AnthropicRequestLike>(body: T): T {
  if (!body || !Array.isArray(body.messages)) return body;

  const lifted: string[] = [];
  const kept: unknown[] = [];
  for (const message of body.messages as AnthropicMessageLike[]) {
    if (message && typeof message === 'object' && message.role === 'system') {
      const text = anthropicContentText(message.content);
      if (text) lifted.push(text);
      continue;
    }
    kept.push(message);
  }
  if (lifted.length === 0) return body;

  const system = existingSystemBlocks(body.system);
  for (const text of lifted) system.push({ type: 'text', text });
  return { ...body, system, messages: kept };
}
