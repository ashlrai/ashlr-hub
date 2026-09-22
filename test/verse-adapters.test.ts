/**
 * test/verse-adapters.test.ts — Verse CLI adapters: argv/env construction and
 * stdout-line parsing for claude (stream-json), codex (exec JSONL) and grok
 * (Anthropic Messages wire NDJSON). Pure: no spawns, no filesystem.
 */
import { describe, expect, it } from 'vitest';

import { adapterFor } from '../src/core/verse/adapters/index.js';
import { createAnthropicStreamParser, anthropicEnvBaseUrl } from '../src/core/verse/adapters/claude.js';
import { createCodexParser } from '../src/core/verse/adapters/codex.js';
import type { VerseSeatLaunch } from '../src/core/verse/session-engine.js';
import type { VerseEvent, VerseSeat, VerseSession } from '../src/core/verse/types.js';

const SEAT: VerseSeat = {
  id: 'claude-max',
  engine: 'claude',
  label: 'Claude Max',
  accountId: 'claude-max',
  models: [{ id: 'claude-opus-5', label: 'Opus 5', contextWindow: 200_000 }],
  contextWindow: 200_000,
  health: { state: 'unknown', summary: null, windows: [], observedAt: null },
};

function session(overrides: Partial<VerseSession> = {}): VerseSession {
  return {
    id: 'sess-1',
    title: 'x',
    projectPath: '/tmp/proj',
    engine: 'claude',
    accountId: 'claude-max',
    seatId: 'claude-max',
    model: 'claude-opus-5',
    nativeSessionId: '11111111-2222-4333-8444-555555555555',
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
    status: 'idle',
    turnCount: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 0, contextWindow: 200_000 },
    lastError: null,
    ...overrides,
  };
}

function launch(overrides: Partial<VerseSeatLaunch> = {}): VerseSeatLaunch {
  return { seat: SEAT, launcher: ['/usr/local/bin/node', '/home/u/.ashlr/native-profiles/claude-max/launcher.mjs'], ollamaBaseUrl: 'http://127.0.0.1:11434', ...overrides };
}

function feed(parser: { push(l: string): unknown[]; finish(c: number | null): unknown[] }, lines: unknown[], exitCode: number | null = 0): Array<Omit<VerseEvent, 'seq' | 'at'>> {
  const out: Array<Omit<VerseEvent, 'seq' | 'at'>> = [];
  for (const line of lines) {
    const text = typeof line === 'string' ? line : JSON.stringify(line);
    out.push(...(parser.push(text) as Array<Omit<VerseEvent, 'seq' | 'at'>>));
  }
  out.push(...(parser.finish(exitCode) as Array<Omit<VerseEvent, 'seq' | 'at'>>));
  return out;
}

// ---------------------------------------------------------------------------
// claude
// ---------------------------------------------------------------------------

describe('claude adapter — buildLaunch', () => {
  it('turn 1 uses --session-id via the account launcher; later turns --resume', () => {
    const a = adapterFor('claude');
    const first = a.buildLaunch(session(), 'hello world', launch());
    expect(first.argv.slice(0, 2)).toEqual(['/usr/local/bin/node', '/home/u/.ashlr/native-profiles/claude-max/launcher.mjs']);
    expect(first.argv).toContain('-p');
    // `-p` is boolean; the prompt is the positional, last, behind `--`.
    expect(first.argv.slice(-2)).toEqual(['--', 'hello world']);
    expect(first.argv).toContain('--session-id');
    expect(first.argv[first.argv.indexOf('--session-id') + 1]).toBe('11111111-2222-4333-8444-555555555555');
    expect(first.argv).not.toContain('--resume');
    expect(first.argv).toEqual(expect.arrayContaining(['--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', 'claude-opus-5', '--permission-mode', 'acceptEdits', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']));
    expect(first.stdin).toBeNull();
    expect(first.cwd).toBe('/tmp/proj');
    expect(first.env).toEqual({});

    const second = a.buildLaunch(session({ turnCount: 1 }), 'again', launch());
    expect(second.argv).toContain('--resume');
    expect(second.argv[second.argv.indexOf('--resume') + 1]).toBe('11111111-2222-4333-8444-555555555555');
    expect(second.argv).not.toContain('--session-id');
  });

  it('keeps a leading-dash message as text, never as options', () => {
    const a = adapterFor('claude');
    for (const text of ['- a\n- b', '--dangerously-skip-permissions rm -rf /', '--add-dir / && echo pwned']) {
      const l = a.buildLaunch(session(), text, launch());
      expect(l.argv[l.argv.length - 1]).toBe(text);
      expect(l.argv[l.argv.length - 2]).toBe('--');
      // Every real option sits before the marker.
      expect(l.argv.indexOf('--permission-mode')).toBeLessThan(l.argv.indexOf('--'));
      expect(l.argv.indexOf('--')).toBe(l.argv.lastIndexOf('--'));
      expect(l.stdin).toBeNull();
    }
  });

  it('engine=local runs the plain claude binary pointed at Ollama', () => {
    const a = adapterFor('local');
    const l = a.buildLaunch(session({ engine: 'local', model: 'qwen3-coder:30b' }), 'hi', launch({ launcher: null, ollamaBaseUrl: 'http://127.0.0.1:11434/v1/' }));
    expect(l.argv[0]).toBe('claude');
    expect(l.env).toEqual({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434',
      ANTHROPIC_AUTH_TOKEN: 'ollama',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    });
    expect(l.argv[l.argv.indexOf('--model') + 1]).toBe('qwen3-coder:30b');
  });

  it('strips /v1 from the ollama base', () => {
    expect(anthropicEnvBaseUrl('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434');
    expect(anthropicEnvBaseUrl('http://127.0.0.1:11434/')).toBe('http://127.0.0.1:11434');
    expect(anthropicEnvBaseUrl('http://127.0.0.1:11434')).toBe('http://127.0.0.1:11434');
  });
});

const CLAUDE_TURN = [
  { type: 'system', subtype: 'init', session_id: 'sid-abc', model: 'claude-opus-5', cwd: '/tmp/proj' },
  { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_1', role: 'assistant', content: [], usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 1 } } } },
  { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me ' } } },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'look.' } } },
  { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
  { type: 'assistant', message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'Let me look.' }], usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 5 } } },
  { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} } } },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"file_path":' } } },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"/tmp/proj/a.ts"}' } } },
  { type: 'stream_event', event: { type: 'content_block_stop', index: 1 } },
  { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } } },
  { type: 'stream_event', event: { type: 'message_stop' } },
  { type: 'assistant', message: { id: 'msg_1', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/proj/a.ts' } }], usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 20 } } },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'export const a = 1;', is_error: false }] } },
  { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_2', role: 'assistant', content: [], usage: { input_tokens: 15, cache_read_input_tokens: 1210, cache_creation_input_tokens: 300, output_tokens: 1 } } } },
  { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } } },
  { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
  { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } } },
  { type: 'stream_event', event: { type: 'message_stop' } },
  { type: 'assistant', message: { id: 'msg_2', role: 'assistant', content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: 15, cache_read_input_tokens: 1210, cache_creation_input_tokens: 300, output_tokens: 3 } } },
  'this is not json',
  '{"type":"stream_event","event":',
  { type: 'result', subtype: 'success', is_error: false, session_id: 'sid-abc', num_turns: 2, result: 'Done.', usage: { input_tokens: 25, cache_read_input_tokens: 2210, cache_creation_input_tokens: 500, output_tokens: 23 } },
];

describe('claude adapter — parser', () => {
  it('normalizes a tool-using turn: deltas, deduped messages, tool use/result, usage, session id', () => {
    const a = adapterFor('claude');
    const parser = a.createParser('t1');
    const events = feed(parser, CLAUDE_TURN);

    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === 'text-delta')).toHaveLength(3);
    expect(types.filter((t) => t === 'assistant-message')).toHaveLength(2);
    expect(types.filter((t) => t === 'tool-use')).toHaveLength(1);
    expect(types.filter((t) => t === 'tool-result')).toHaveLength(1);
    expect(types.filter((t) => t === 'usage')).toHaveLength(1);
    expect(types).not.toContain('error');

    const messages = events.filter((e) => e.type === 'assistant-message').map((e) => (e as { text: string }).text);
    expect(messages).toEqual(['Let me look.', 'Done.']);

    const toolUse = events.find((e) => e.type === 'tool-use') as { toolUseId: string; name: string; input: unknown };
    expect(toolUse.toolUseId).toBe('toolu_1');
    expect(toolUse.name).toBe('Read');
    expect(toolUse.input).toEqual({ file_path: '/tmp/proj/a.ts' });

    const toolResult = events.find((e) => e.type === 'tool-result') as { toolUseId: string; output: string; isError: boolean };
    expect(toolResult).toMatchObject({ toolUseId: 'toolu_1', output: 'export const a = 1;', isError: false });

    const usage = (events.find((e) => e.type === 'usage') as { usage: VerseSession['usage'] }).usage;
    // Turn totals come from `result`; context occupancy from the LAST assistant call.
    expect(usage.inputTokens).toBe(25);
    expect(usage.outputTokens).toBe(23);
    expect(usage.cacheReadTokens).toBe(2210);
    expect(usage.cacheCreationTokens).toBe(500);
    expect(usage.contextTokens).toBe(15 + 1210 + 300);
    expect(usage.contextWindow).toBeNull();

    // Ordering: deltas precede the deduped message; usage comes last before finish.
    expect(types.indexOf('text-delta')).toBeLessThan(types.indexOf('assistant-message'));
    expect(types[types.length - 1]).toBe('usage');

    expect(parser.nativeSessionId()).toBe('sid-abc');
    for (const e of events) expect((e as { turnId: string }).turnId).toBe('t1');
  });

  it('emits an error for a non-success result; exit codes are left to the engine', () => {
    const a = adapterFor('claude');
    const bad = feed(a.createParser('t2'), [
      { type: 'system', subtype: 'init', session_id: 's' },
      { type: 'result', subtype: 'error_max_turns', is_error: true, session_id: 's', usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    expect(bad.map((e) => e.type)).toEqual(['error', 'usage']);
    expect((bad[0] as { message: string }).message).toContain('error_max_turns');

    // Exit-code errors are the engine's job (it holds the stderr tail); the parser stays quiet.
    const crashed = feed(a.createParser('t3'), [{ type: 'system', subtype: 'init', session_id: 's' }], 1);
    expect(crashed).toEqual([]);

    const clean = feed(a.createParser('t4'), [], 0);
    expect(clean).toEqual([]);
  });

  it('never throws on garbage and surfaces thinking blocks', () => {
    const parser = createAnthropicStreamParser('t5');
    expect(parser.push('')).toEqual([]);
    expect(parser.push('{')).toEqual([]);
    expect(parser.push('[1,2]')).toEqual([]);
    expect(parser.push('{"type":"stream_event","event":null}')).toEqual([]);
    expect(parser.push('{"type":"assistant","message":{"content":"plain string"}}')).toEqual([
      { type: 'assistant-message', turnId: 't5', text: 'plain string' },
    ]);
    expect(parser.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }] } }))).toEqual([
      { type: 'thinking', turnId: 't5', text: 'hmm' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// codex
// ---------------------------------------------------------------------------

const CODEX_SEAT: VerseSeat = { ...SEAT, id: 'codex-a', engine: 'codex', accountId: 'codex-a', models: [{ id: 'gpt-5.5', label: 'GPT-5.5', contextWindow: 272_000 }] };

describe('codex adapter — buildLaunch', () => {
  it('turn 1 is `exec --json ... -` with the prompt on stdin; later turns `exec resume <thread>`', () => {
    const a = adapterFor('codex');
    const l = launch({ seat: CODEX_SEAT, launcher: ['/usr/local/bin/node', '/x/launcher.mjs'] });
    const first = a.buildLaunch(session({ engine: 'codex', seatId: 'codex-a', model: 'gpt-5.5', nativeSessionId: null }), 'do it', l);
    expect(first.argv).toEqual(['/usr/local/bin/node', '/x/launcher.mjs', 'exec', '--json', '--model', 'gpt-5.5', '--cd', '/tmp/proj', '--sandbox', 'workspace-write', '-']);
    expect(first.stdin).toBe('do it');
    expect(first.env).toEqual({});

    const second = a.buildLaunch(session({ engine: 'codex', seatId: 'codex-a', model: 'gpt-5.5', nativeSessionId: 'thread-9', turnCount: 1 }), 'more', l);
    expect(second.argv).toEqual(['/usr/local/bin/node', '/x/launcher.mjs', 'exec', 'resume', 'thread-9', '--json', '-']);
    expect(second.stdin).toBe('more');
  });

  it('falls back to a fresh exec when turn 1 never produced a thread id', () => {
    const a = adapterFor('codex');
    const l = launch({ seat: CODEX_SEAT, launcher: ['/x/launcher.mjs'] });
    const again = a.buildLaunch(session({ engine: 'codex', nativeSessionId: null, turnCount: 1, model: 'gpt-5.5' }), 'retry', l);
    expect(again.argv.slice(1, 3)).toEqual(['exec', '--json']);
  });
});

const CODEX_TURN = [
  { type: 'thread.started', thread_id: 'thr_123' },
  { type: 'turn.started' },
  { type: 'item.started', item: { id: 'item_0', type: 'reasoning', text: '' } },
  { type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: 'Need to inspect the file.' } },
  { type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'cat a.ts', cwd: '/tmp/proj', status: 'in_progress' } },
  { type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'cat a.ts', aggregated_output: 'export const a = 1;\n', exit_code: 0, status: 'completed' } },
  { type: 'item.completed', item: { id: 'item_2', type: 'file_change', status: 'completed', changes: [{ path: '/tmp/proj/a.ts', kind: 'update' }] } },
  { type: 'item.started', item: { id: 'item_3', type: 'mcp_tool_call', server: 'fs', tool: 'stat', arguments: { path: 'a.ts' }, status: 'in_progress' } },
  { type: 'item.completed', item: { id: 'item_3', type: 'mcp_tool_call', server: 'fs', tool: 'stat', arguments: { path: 'a.ts' }, status: 'failed', error: { message: 'no such tool' } } },
  { type: 'item.started', item: { id: 'item_4', type: 'agent_message', text: '' } },
  { type: 'item.completed', item: { id: 'item_4', type: 'agent_message', text: 'Updated a.ts.' } },
  'not json at all',
  { type: 'turn.completed', usage: { input_tokens: 5000, cached_input_tokens: 4000, output_tokens: 120 } },
];

describe('codex adapter — parser', () => {
  it('captures thread_id and normalizes items into tool-use/result, thinking, message and usage', () => {
    const parser = createCodexParser('c1');
    const events = feed(parser, CODEX_TURN);
    expect(parser.nativeSessionId()).toBe('thr_123');

    expect(events.map((e) => e.type)).toEqual([
      'thinking',
      'tool-use', 'tool-result',
      'tool-use', 'tool-result',
      'tool-use', 'tool-result',
      'assistant-message',
      'usage',
    ]);

    const [, cmdUse, cmdResult, fcUse, fcResult, mcpUse, mcpResult, message, usage] = events as Array<Record<string, unknown>>;
    expect(cmdUse).toMatchObject({ toolUseId: 'item_1', name: 'command_execution', input: { command: 'cat a.ts', cwd: '/tmp/proj' } });
    expect(cmdResult).toMatchObject({ toolUseId: 'item_1', output: 'export const a = 1;\n', isError: false });
    expect(fcUse).toMatchObject({ toolUseId: 'item_2', name: 'file_change' });
    expect(fcResult).toMatchObject({ toolUseId: 'item_2', output: 'update /tmp/proj/a.ts', isError: false });
    expect(mcpUse).toMatchObject({ toolUseId: 'item_3', name: 'mcp:fs.stat', input: { path: 'a.ts' } });
    expect(mcpResult).toMatchObject({ toolUseId: 'item_3', output: 'no such tool', isError: true });
    expect(message).toMatchObject({ text: 'Updated a.ts.' });
    // codex's input_tokens includes the cached portion: split so the engine's
    // input + cache-read totals count each token once; context = turn total.
    expect(usage).toMatchObject({ usage: { inputTokens: 1000, cacheReadTokens: 4000, cacheCreationTokens: 0, outputTokens: 120, contextTokens: 5000, contextWindow: null } });
  });

  it('two model calls in one turn: totals are split once and contextTokens is the turn total (an upper bound)', () => {
    // `exec --json` reports one aggregate usage per turn — there is no per-call
    // prompt size — so 2 calls of ~3k prompt each show as input 6000 / cached 2500.
    const events = feed(createCodexParser('c4'), [
      { type: 'thread.started', thread_id: 't2' },
      { type: 'item.completed', item: { id: 'a', type: 'command_execution', command: 'ls', aggregated_output: '', exit_code: 0, status: 'completed' } },
      { type: 'item.completed', item: { id: 'b', type: 'agent_message', text: 'done' } },
      { type: 'turn.completed', usage: { input_tokens: 6000, cached_input_tokens: 2500, output_tokens: 40 } },
    ]);
    const usage = events.find((e) => e.type === 'usage') as { usage: Record<string, unknown> };
    expect(usage.usage).toEqual({ inputTokens: 3500, outputTokens: 40, cacheReadTokens: 2500, cacheCreationTokens: 0, contextTokens: 6000, contextWindow: null });
    // A cached figure larger than input (malformed) never produces negative input.
    const odd = feed(createCodexParser('c5'), [{ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 400, output_tokens: 1 } }]);
    expect((odd[0] as { usage: Record<string, number> }).usage).toMatchObject({ inputTokens: 0, cacheReadTokens: 100 });
  });

  it('reports turn.failed as an error and a failed command as an error result', () => {
    const failed = feed(createCodexParser('c2'), [
      { type: 'thread.started', thread_id: 't' },
      { type: 'item.completed', item: { id: 'i', type: 'command_execution', command: 'false', aggregated_output: '', exit_code: 1, status: 'completed' } },
      { type: 'turn.failed', error: { message: 'model overloaded' } },
    ]);
    expect(failed.map((e) => e.type)).toEqual(['tool-use', 'tool-result', 'error']);
    expect(failed[1]).toMatchObject({ isError: true });
    expect((failed[2] as { message: string }).message).toBe('codex: model overloaded');

    const crashed = feed(createCodexParser('c3'), [], 2);
    expect(crashed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// grok
// ---------------------------------------------------------------------------

const GROK_SEAT: VerseSeat = { ...SEAT, id: 'grok', engine: 'grok', accountId: 'grok', models: [{ id: 'grok-4', label: 'Grok 4', contextWindow: 256_000 }] };

describe('grok adapter — buildLaunch', () => {
  it('builds streaming-messages-json argv with --session-id then --resume', () => {
    const a = adapterFor('grok');
    const l = launch({ seat: GROK_SEAT, launcher: ['/usr/local/bin/node', '/g/launcher.mjs'] });
    const first = a.buildLaunch(session({ engine: 'grok', model: 'grok-4', nativeSessionId: 'g-uuid' }), 'yo', l);
    expect(first.argv).toEqual([
      '/usr/local/bin/node', '/g/launcher.mjs',
      '--output-format', 'streaming-messages-json',
      '--include-partial-messages',
      '--cwd', '/tmp/proj',
      '--model', 'grok-4',
      // dontAsk, not acceptEdits: Grok's acceptEdits leaves
      // `run_terminal_command` needing an approver that a seat does not have,
      // and the turn is cancelled mid-run. Measured against the real CLI.
      '--permission-mode', 'dontAsk',
      '--session-id', 'g-uuid',
      '--single=yo',
    ]);
    expect(first.stdin).toBeNull();
    const second = a.buildLaunch(session({ engine: 'grok', model: 'grok-4', nativeSessionId: 'g-uuid', turnCount: 3 }), 'yo', l);
    expect(second.argv.slice(-3)).toEqual(['--resume', 'g-uuid', '--single=yo']);
  });

  it('passes a leading-dash message in the --single=<text> spelling clap accepts as a value', () => {
    const a = adapterFor('grok');
    const l = launch({ seat: GROK_SEAT, launcher: ['/usr/local/bin/node', '/g/launcher.mjs'] });
    for (const text of ['- a\n- b', '--dangerously-skip-permissions x']) {
      const argv = a.buildLaunch(session({ engine: 'grok', model: 'grok-4', nativeSessionId: 'g-uuid' }), text, l).argv;
      expect(argv[argv.length - 1]).toBe(`--single=${text}`);
      expect(argv).not.toContain('-p');
      expect(argv).not.toContain(text);
    }
  });
});

const GROK_TURN = [
  { type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: 'grok-4', content: [], usage: { input_tokens: 800, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' there' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'bash', input: {} } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"cmd":"ls"}' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 12 } },
  { type: 'message_stop' },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: 'a.ts\nb.ts' }], is_error: false }] } },
  { type: 'message_start', message: { id: 'm2', type: 'message', role: 'assistant', model: 'grok-4', content: [], usage: { input_tokens: 950, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Two files.' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
  { type: 'message_stop' },
];

describe('grok adapter — parser', () => {
  it('parses bare Anthropic wire events and totals usage across API calls', () => {
    const a = adapterFor('grok');
    const parser = a.createParser('g1');
    const events = feed(parser, GROK_TURN);
    expect(events.map((e) => e.type)).toEqual([
      'text-delta', 'text-delta', 'assistant-message',
      'tool-use',
      'tool-result',
      'text-delta', 'assistant-message',
      'usage',
    ]);
    expect(events[2]).toMatchObject({ text: 'Hello there' });
    expect(events[3]).toMatchObject({ toolUseId: 'tu_1', name: 'bash', input: { cmd: 'ls' } });
    expect(events[4]).toMatchObject({ toolUseId: 'tu_1', output: 'a.ts\nb.ts', isError: false });
    expect(events[7]).toMatchObject({
      usage: { inputTokens: 1750, outputTokens: 16, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 950, contextWindow: null },
    });
    // grok's conversation id is the uuid we minted; nothing to capture from output.
    expect(parser.nativeSessionId()).toBeNull();
  });

  it('accepts the same events wrapped in claude\'s stream_event envelope', () => {
    const wrapped = GROK_TURN.map((ev) => (ev.type === 'user' ? ev : { type: 'stream_event', event: ev }));
    const bare = feed(adapterFor('grok').createParser('g2'), GROK_TURN);
    const viaWrapper = feed(adapterFor('grok').createParser('g2'), wrapped);
    expect(viaWrapper).toEqual(bare);
  });
});

describe('adapterFor', () => {
  it('maps every engine and shares the claude adapter for local', () => {
    expect(adapterFor('local')).toBe(adapterFor('claude'));
    expect(adapterFor('codex')).not.toBe(adapterFor('claude'));
    expect(adapterFor('grok')).not.toBe(adapterFor('claude'));
    expect(() => adapterFor('nope' as never)).toThrow(/unknown verse engine/);
  });
});
