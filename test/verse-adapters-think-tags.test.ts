/**
 * test/verse-adapters-think-tags.test.ts — local reasoning models (Qwen3,
 * QwQ, DeepSeek-R1 via llama-server or an older Ollama) inline their chain of
 * thought in the TEXT block as `<think>…</think>`. On a local turn the claude
 * stream parser splits it: reasoning → thinking-delta / thinking (raw), answer
 * → text-delta / assistant-message. Claude and grok text stays verbatim.
 *
 * Frames follow claude 2.1.280's order (see verse-adapters-reasoning.test.ts):
 * the `assistant` envelope repeating a block arrives BEFORE its
 * content_block_stop.
 */
import { describe, expect, it } from 'vitest';

import type { VerseParsedEvent } from '../src/core/verse/adapters/index.js';
import { createAnthropicStreamParser } from '../src/core/verse/adapters/claude.js';
import { VERSE_TRANSIENT_EVENT_TYPES } from '../src/core/verse/types.js';

function clock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

function ofType<T extends VerseParsedEvent['type']>(events: VerseParsedEvent[], type: T): Array<Extract<VerseParsedEvent, { type: T }>> {
  return events.filter((e): e is Extract<VerseParsedEvent, { type: T }> => e.type === type);
}

/** The persisted block events (usage and live text-deltas aside). */
function persisted(events: VerseParsedEvent[]): VerseParsedEvent[] {
  return events.filter((e) => !VERSE_TRANSIENT_EVENT_TYPES.has(e.type) && e.type !== 'usage' && e.type !== 'text-delta');
}

/** One streamed text block from `model`, as the claude CLI frames it, split into `chunks`. */
function textTurn(model: string, chunks: readonly string[], opts: { envelope?: boolean; stop?: boolean } = {}): unknown[] {
  const full = chunks.join('');
  const se = (event: unknown): unknown => ({ type: 'stream_event', event });
  return [
    { type: 'system', subtype: 'init', session_id: 'sid', model },
    se({ type: 'message_start', message: { id: 'msg_1', model, usage: { input_tokens: 10, output_tokens: 0 } } }),
    se({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    ...chunks.map((text) => se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })),
    ...(opts.envelope === false ? [] : [{ type: 'assistant', message: { id: 'msg_1', model, content: [{ type: 'text', text: full }] } }]),
    ...(opts.stop === false ? [] : [se({ type: 'content_block_stop', index: 0 }), se({ type: 'message_stop' })]),
  ];
}

function replay(lines: readonly unknown[], engine = 'claude', stepMs = 100): VerseParsedEvent[] {
  const c = clock();
  const parser = createAnthropicStreamParser('t', engine, { now: c.now });
  const out: VerseParsedEvent[] = [];
  for (const line of lines) {
    c.advance(stepMs);
    out.push(...parser.push(JSON.stringify(line)));
  }
  out.push(...parser.finish(0));
  return out;
}

const QWEN = 'qwen3:32b';

describe('claude parser — inline <think> on local models', () => {
  it('splits a streamed block with tags split across deltas; nothing is emitted twice, no tag characters leak', () => {
    const events = replay(textTurn(QWEN, ['<th', 'ink>\nLet me', ' compute.</th', 'ink>\n\n39', '1']));
    const thinkingDeltas = ofType(events, 'thinking-delta').map((d) => d.text);
    const textDeltas = ofType(events, 'text-delta').map((d) => d.text);
    expect(thinkingDeltas.join('')).toBe('Let me compute.');
    expect(textDeltas.join('')).toBe('391');
    for (const chunk of [...thinkingDeltas, ...textDeltas]) expect(chunk).not.toMatch(/[<>]/);

    // Persisted: thinking (raw) BEFORE the answer, each once, despite the envelope repeating the raw block.
    expect(persisted(events).map((e) => e.type)).toEqual(['thinking', 'assistant-message']);
    const [thinking] = ofType(events, 'thinking');
    // `<think>` completed on frame 4 (t=500), `</think>` on frame 6 (t=700).
    expect(thinking).toEqual({ type: 'thinking', turnId: 't', text: 'Let me compute.', kind: 'raw', durationMs: 200 });
    expect(ofType(events, 'assistant-message')).toEqual([{ type: 'assistant-message', turnId: 't', text: '391' }]);

    // The phase goes thinking → writing, never writing first (the block opened with `<think>`).
    const phases = ofType(events, 'progress').map((p) => p.phase);
    expect(phases.indexOf('thinking')).toBeGreaterThanOrEqual(0);
    expect(phases.indexOf('thinking')).toBeLessThan(phases.indexOf('writing'));
  });

  it('survives a tag streamed one character at a time', () => {
    const raw = '  <think>abc</think>\nxyz';
    const events = replay(textTurn(QWEN, [...raw]));
    expect(ofType(events, 'thinking-delta').map((d) => d.text).join('')).toBe('abc');
    expect(ofType(events, 'text-delta').map((d) => d.text).join('')).toBe('xyz');
    expect(ofType(events, 'thinking').map((e) => e.text)).toEqual(['abc']);
    expect(ofType(events, 'assistant-message').map((e) => e.text)).toEqual(['xyz']);
  });

  it('without the stream: the envelope alone is split (block array and string content)', () => {
    const block = replay([
      { type: 'system', subtype: 'init', session_id: 'sid', model: 'gpt-oss:20b' },
      { type: 'assistant', message: { id: 'm1', model: 'gpt-oss:20b', content: [{ type: 'text', text: '<think>Greet back.</think>\n\nHello!' }] } },
    ]);
    expect(persisted(block)).toEqual([
      { type: 'thinking', turnId: 't', text: 'Greet back.', kind: 'raw' },
      { type: 'assistant-message', turnId: 't', text: 'Hello!' },
    ]);
    const str = replay([
      { type: 'system', subtype: 'init', session_id: 'sid', model: QWEN },
      { type: 'assistant', message: { id: 'm1', model: QWEN, content: '<think>x</think>y' } },
    ]);
    expect(persisted(str).map((e) => (e.type === 'thinking' || e.type === 'assistant-message' ? `${e.type}:${e.text}` : e.type))).toEqual(['thinking:x', 'assistant-message:y']);
  });

  it('an unclosed <think> at block close is all reasoning: no assistant-message', () => {
    const events = replay(textTurn(QWEN, ['<think>Still going', ' and going'], { envelope: false, stop: false }));
    expect(ofType(events, 'thinking-delta').map((d) => d.text).join('')).toBe('Still going and going');
    expect(ofType(events, 'text-delta')).toEqual([]);
    expect(ofType(events, 'assistant-message')).toEqual([]);
    const thinking = ofType(events, 'thinking');
    expect(thinking).toHaveLength(1);
    // Started on frame 4 (t=400), never closed → until finish() (t=500).
    expect(thinking[0]).toMatchObject({ text: 'Still going and going', kind: 'raw', durationMs: 100 });
  });

  it('close-only template (`<think>` was in the prompt): split at close, suffix is the answer', () => {
    const events = replay(textTurn(QWEN, ['I should greet.\n', '</think>', '\n\nHi there']));
    // Streamed provisionally as text; the final assistant-message supersedes the bubble.
    expect(ofType(events, 'text-delta').map((d) => d.text).join('')).toBe('I should greet.\n</think>\n\nHi there');
    expect(persisted(events)).toEqual([
      // Block opened at t=300; `</think>` arrived at t=500.
      { type: 'thinking', turnId: 't', text: 'I should greet.', kind: 'raw', durationMs: 200 },
      { type: 'assistant-message', turnId: 't', text: 'Hi there' },
    ]);
  });

  it('an empty think section (Qwen3 non-thinking mode) yields no thinking at all', () => {
    const events = replay(textTurn(QWEN, ['<think>\n\n</think>\n\n', 'Hi']));
    expect(ofType(events, 'thinking-delta')).toEqual([]);
    expect(ofType(events, 'thinking')).toEqual([]);
    expect(ofType(events, 'text-delta').map((d) => d.text).join('')).toBe('Hi');
    expect(ofType(events, 'assistant-message').map((e) => e.text)).toEqual(['Hi']);
  });

  it('a local answer that merely starts with "<" streams verbatim', () => {
    const events = replay(textTurn(QWEN, ['<', 'div>ok</div>']));
    expect(ofType(events, 'text-delta').map((d) => d.text).join('')).toBe('<div>ok</div>');
    expect(ofType(events, 'thinking')).toEqual([]);
    expect(ofType(events, 'assistant-message').map((e) => e.text)).toEqual(['<div>ok</div>']);
  });
});

describe('claude parser — inline <think> is NOT touched outside local models', () => {
  const RAW = '<think>Models like Qwen3 wrap reasoning like this.</think>\n\nThat is the <think> tag format.';

  it('a Claude answer discussing <think> tags stays verbatim', () => {
    const events = replay(textTurn('claude-opus-5-5', ['<think>Models like', ' Qwen3 wrap reasoning like this.</think>\n\nThat is the <think> tag format.']));
    expect(ofType(events, 'text-delta').map((d) => d.text).join('')).toBe(RAW);
    expect(ofType(events, 'thinking-delta')).toEqual([]);
    expect(ofType(events, 'thinking')).toEqual([]);
    expect(ofType(events, 'assistant-message')).toEqual([{ type: 'assistant-message', turnId: 't', text: RAW }]);
  });

  it('grok text stays verbatim', () => {
    const events = replay(textTurn('grok-4.7', [RAW]), 'grok');
    expect(ofType(events, 'thinking')).toEqual([]);
    expect(ofType(events, 'assistant-message').map((e) => e.text)).toEqual([RAW]);
  });

  it('an unknown model (no init, no message model) stays verbatim', () => {
    const events = replay([{ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: RAW }] } }]);
    expect(ofType(events, 'thinking')).toEqual([]);
    expect(ofType(events, 'assistant-message').map((e) => e.text)).toEqual([RAW]);
  });
});
