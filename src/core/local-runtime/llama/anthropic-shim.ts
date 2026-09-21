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
 * So the correct fix is upstream of the template: get every system turn out of
 * `messages` without dropping content and without disturbing prompt ORDER.
 *
 * ORDER IS LOAD-BEARING — this is the expensive part to get wrong. Claude Code
 * appends a fresh system turn on every request carrying a counter that changes
 * each time:
 *
 *     <total_tokens>15000000 tokens left</total_tokens>   turn 1
 *     <total_tokens>14976577 tokens left</total_tokens>   turn 2
 *
 * An earlier version of this file folded EVERY system turn into the top-level
 * `system` block. That block renders before the whole conversation, so each new
 * counter line was inserted ahead of all prior context and the prompt prefix
 * changed on every single turn. llama-server could reuse nothing and reprocessed
 * the entire context each request — measured at 23,301 prompt tokens per turn
 * against a conversation that only grew by ~300, and 423,197 tokens reprocessed
 * across one four-agent run. The turns still produced correct results, so the
 * only symptom was that everything was slow.
 *
 * Claude Code's history is otherwise strictly append-only, so the rule here is:
 * fold only system turns from the preamble — those before the first assistant
 * turn, which are resent byte-identical every request — and re-home every later
 * one AT ITS OWN POSITION. The prompt then grows append-only and llama-server's
 * prefix cache holds.
 *
 * The preamble carve-out matters for behaviour, not just speed: re-homing the
 * SessionStart hook into the operator's own task message made one measured run
 * answer `DONE` without doing the work.
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
 * Text prepended to a system turn that is re-homed as a user turn, so the model
 * can still tell it apart from something the operator typed.
 */
const RELOCATED_SYSTEM_PREFIX = '[system]';

function relocatedSystemText(text: string): string {
  return text ? `${RELOCATED_SYSTEM_PREFIX}\n${text}` : RELOCATED_SYSTEM_PREFIX;
}

/**
 * Normalise a request so llama-server's chat template accepts it.
 *
 * Preamble system turns fold into the top-level `system` block. Every later one
 * stays where it is, merged into the preceding user turn when there is one (so
 * roles keep alternating) or emitted as its own user turn otherwise.
 *
 * Returns the body unchanged when there is nothing to move, so a request that
 * already satisfies the template is forwarded byte-for-byte.
 */
export function normaliseAnthropicRequest<T extends AnthropicRequestLike>(body: T): T {
  if (!body || !Array.isArray(body.messages)) return body;

  const lifted: string[] = [];
  const kept: unknown[] = [];
  let seenAssistantTurn = false;
  let changed = false;

  for (const message of body.messages as AnthropicMessageLike[]) {
    const isSystem =
      message !== null && typeof message === 'object' && message.role === 'system';

    if (!isSystem) {
      if (message !== null && typeof message === 'object' && message.role === 'assistant') {
        seenAssistantTurn = true;
      }
      kept.push(message);
      continue;
    }

    changed = true;
    const text = anthropicContentText(message.content);

    if (!seenAssistantTurn) {
      // Still the preamble (nothing has been answered yet). These turns — the
      // SessionStart hook, for one — are resent unchanged on every request, so
      // folding them into `system` keeps the prefix stable AND keeps standing
      // instructions where the model reads them as instructions rather than as
      // part of the operator's task text.
      if (text) lifted.push(text);
      continue;
    }

    // Mid-conversation: keep it HERE, as its own turn.
    //
    // Do NOT merge it into the preceding message. An earlier attempt did, by
    // flattening that message with anthropicContentText() — which only reads
    // `.text` blocks. A tool_result block carries `.content`, not `.text`, so
    // flattening a tool-result turn yielded the empty string and the merge
    // REPLACED every tool result with just the counter line. Agents then saw
    // no file contents and no command output; one correctly refused to report
    // success. Two adjacent user turns are harmless here by comparison.
    kept.push({ role: 'user', content: relocatedSystemText(text) });
  }

  if (!changed) return body;

  const system = existingSystemBlocks(body.system);
  for (const text of lifted) system.push({ type: 'text', text });
  return { ...body, system, messages: kept };
}
