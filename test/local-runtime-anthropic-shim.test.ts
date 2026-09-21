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
  normaliseAnthropicRequest,
} from '../src/core/local-runtime/llama/anthropic-shim.js';

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

  it('flattens both content spellings', () => {
    expect(anthropicContentText('plain')).toBe('plain');
    expect(anthropicContentText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\nb');
    expect(anthropicContentText(undefined)).toBe('');
  });
});
