/**
 * Pins the normalisation that makes Claude Code work against llama-server.
 *
 * The shape asserted here is the one captured from a real Claude Code request:
 * a top-level `system` list AND a system-role turn sitting second in
 * `messages`, which is what Qwen3.8's template refuses.
 */
import { describe, expect, it } from 'vitest';
import {
  anthropicContentText,
  applyLocalAgentDefaults,
  normaliseAnthropicRequest,
} from '../src/core/local-runtime/llama/anthropic-shim.js';
import { NO_LOCAL_AGENT_DEFAULTS } from '../src/core/local-runtime/llama/config.js';

describe('normaliseAnthropicRequest', () => {
  it('hoists the system turn Claude Code puts second, preserving both texts', () => {
    const body = {
      model: 'local',
      system: [{ type: 'text', text: 'outer system' }],
      messages: [
        { role: 'user', content: 'do the thing' },
        { role: 'system', content: [{ type: 'text', text: 'inner system' }] },
      ],
    };
    const out = normaliseAnthropicRequest(body);
    expect(out.messages.map((m) => (m as { role: string }).role)).toEqual(['user']);
    expect(out.system).toEqual([
      { type: 'text', text: 'outer system' },
      { type: 'text', text: 'inner system' },
    ]);
  });

  it('drops no content — every lifted system turn survives', () => {
    const out = normaliseAnthropicRequest({
      messages: [
        { role: 'system', content: 'first' },
        { role: 'user', content: 'hi' },
        { role: 'system', content: 'second' },
      ],
    });
    // Silently losing a system turn would leave the agent without its
    // instructions and NO error, which is worse than the 500 this replaces.
    expect((out.system as { text: string }[]).map((b) => b.text)).toEqual(['first', 'second']);
    expect(out.messages).toHaveLength(1);
  });

  it('preserves the order of non-system turns', () => {
    const out = normaliseAnthropicRequest({
      messages: [
        { role: 'user', content: 'a' },
        { role: 'system', content: 's' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
      ],
    });
    expect(out.messages.map((m) => (m as { content: string }).content)).toEqual(['a', 'b', 'c']);
  });

  it('returns a request that already complies untouched', () => {
    const body = { model: 'local', system: 'sys', messages: [{ role: 'user', content: 'hi' }] };
    expect(normaliseAnthropicRequest(body)).toBe(body);
  });

  it('tolerates junk rather than throwing into the proxy path', () => {
    expect(normaliseAnthropicRequest({ messages: 'not-an-array' } as never).messages).toBe('not-an-array');
    expect(normaliseAnthropicRequest({} as never)).toEqual({});
    const out = normaliseAnthropicRequest({
      messages: [{ role: 'system', content: [{ type: 'image' }, { type: 'text', text: 'keep' }] }, { role: 'user', content: 'x' }],
    });
    expect((out.system as { text: string }[])[0]?.text).toBe('keep');
  });

  it('leaves a post-answer system turn in place instead of hoisting it', () => {
    const out = normaliseAnthropicRequest({
      system: [{ type: 'text', text: 'base' }],
      messages: [
        { role: 'user', content: 'task' },
        { role: 'system', content: 'hook' },
        { role: 'assistant', content: 'working' },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'FILE' }] },
        { role: 'system', content: '<total_tokens>14976577 tokens left</total_tokens>' },
      ],
    });
    // The preamble folds in; the per-turn counter must not, or it lands ahead
    // of the whole conversation and changes the prompt prefix every request.
    expect((out.system as { text: string }[]).map((b) => b.text)).toEqual(['base', 'hook']);
    expect(out.messages.map((m) => (m as { role: string }).role)).toEqual([
      'user', 'assistant', 'user', 'user',
    ]);
    expect(String((out.messages[3] as { content: unknown }).content)).toContain('14976577');
  });

  it('never rewrites a tool result while re-homing a system turn', () => {
    const toolTurn = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'FILE CONTENTS' }],
    };
    const out = normaliseAnthropicRequest({
      messages: [
        { role: 'user', content: 'task' },
        { role: 'assistant', content: 'working' },
        toolTurn,
        { role: 'system', content: 'counter' },
      ],
    });
    // Regression: merging the system turn into this message flattened it with a
    // text-only reader. tool_result carries `.content`, not `.text`, so the
    // merge replaced every tool result with the counter line and agents saw no
    // file contents or command output at all.
    expect(out.messages[2]).toBe(toolTurn);
  });

  it('grows append-only across turns, so the cached prefix survives', () => {
    const preamble = [
      { role: 'user', content: 'task' },
      { role: 'system', content: 'hook' },
    ];
    const turn2 = normaliseAnthropicRequest({
      system: [{ type: 'text', text: 'base' }],
      messages: [...preamble,
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'r1' },
        { role: 'system', content: 'counter-1' }],
    });
    const turn3 = normaliseAnthropicRequest({
      system: [{ type: 'text', text: 'base' }],
      messages: [...preamble,
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'r1' },
        { role: 'system', content: 'counter-1' },
        { role: 'assistant', content: 'a2' },
        { role: 'user', content: 'r2' },
        { role: 'system', content: 'counter-2' }],
    });
    // This is the whole point: an identical system block and a message list
    // that only ever gains entries at the end. Anything else makes
    // llama-server reprocess the entire context on every turn.
    expect(turn3.system).toEqual(turn2.system);
    expect(turn3.messages.slice(0, turn2.messages.length)).toEqual(turn2.messages);
  });

  it('flattens both content spellings', () => {
    expect(anthropicContentText('plain')).toBe('plain');
    expect(anthropicContentText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\nb');
    expect(anthropicContentText(undefined)).toBe('');
  });
});

describe('applyLocalAgentDefaults', () => {
  const none = NO_LOCAL_AGENT_DEFAULTS;

  it('returns the SAME REFERENCE when nothing is configured', () => {
    // normaliseMessagesBody uses identity to decide whether to forward the
    // client's original bytes, so this is behaviour, not an optimisation.
    const body = { model: 'local', messages: [] };
    expect(applyLocalAgentDefaults(body, none)).toBe(body);
  });

  // MEASURED: on /v1/messages a top-level `reasoning_effort` is dropped by
  // llama-server, while chat_template_kwargs.reasoning_effort reaches the
  // template. Sending the obvious spelling would be a silent no-op.
  it('carries reasoning effort through chat_template_kwargs, not top level', () => {
    const out = applyLocalAgentDefaults(
      { model: 'local', messages: [] },
      { ...none, reasoningEffort: 'low' },
    ) as Record<string, unknown>;
    expect(out['chat_template_kwargs']).toEqual({ reasoning_effort: 'low' });
    expect(out['reasoning_effort']).toBeUndefined();
  });

  it('merges into chat_template_kwargs the client already sent', () => {
    const out = applyLocalAgentDefaults(
      { model: 'local', messages: [], chat_template_kwargs: { enable_thinking: true } },
      { ...none, reasoningEffort: 'medium' },
    ) as Record<string, unknown>;
    expect(out['chat_template_kwargs']).toEqual({
      enable_thinking: true,
      reasoning_effort: 'medium',
    });
  });

  it('never overrides an effort or sampling value the client chose', () => {
    const body = {
      model: 'local',
      messages: [],
      temperature: 0.1,
      chat_template_kwargs: { reasoning_effort: 'xhigh' },
    };
    const out = applyLocalAgentDefaults(body, {
      reasoningEffort: 'low', temperature: 0.9, topP: 0.5, topK: 7,
    }) as Record<string, unknown>;
    expect(out['temperature']).toBe(0.1);
    expect(out['chat_template_kwargs']).toEqual({ reasoning_effort: 'xhigh' });
    // top_p/top_k were absent, so those DO get filled in.
    expect(out['top_p']).toBe(0.5);
    expect(out['top_k']).toBe(7);
  });

  it('puts sampling at the top level, where the Anthropic schema carries it', () => {
    const out = applyLocalAgentDefaults(
      { model: 'local', messages: [] },
      { ...none, temperature: 0.2, topP: 0.9, topK: 20 },
    ) as Record<string, unknown>;
    expect(out).toMatchObject({ temperature: 0.2, top_p: 0.9, top_k: 20 });
  });
});
