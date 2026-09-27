/**
 * test/verse-trace.test.ts — the normalized reasoning / action / source
 * schema (core/verse/trace.ts, V3.15).
 *
 * End to end per adapter: real-shaped CLI stdout → the adapter's parser →
 * stamped VerseEvents → `normalizeVerseEvents`, asserting the sources each
 * seat's tool calls prove and the one-line summary per turn. Then the pieces:
 * shell-read parsing (codex reads with sed/nl/cat), web results, citation
 * numbering and range merging, the write-side lowering a new adapter (the
 * Devin chat seat) can emit through, and wire validation.
 */
import { describe, expect, it } from 'vitest';

import type { VerseParsedEvent } from '../src/core/verse/adapters/index.js';
import { createAnthropicStreamParser } from '../src/core/verse/adapters/claude.js';
import { createCodexParser } from '../src/core/verse/adapters/codex.js';
import {
  baseToolName,
  classifyPath,
  collateSources,
  describeTurnWork,
  emptyTurnStats,
  formatRanges,
  isVerseSource,
  lowerTraceEvent,
  mergeRanges,
  normalizeUrl,
  normalizeVerseEvents,
  reasoningPolicyFor,
  shellReads,
  sourcesFromToolCall,
  toolActionForName,
  type VerseTraceEvent,
} from '../src/core/verse/trace.js';
import { isTransientVerseEvent, type VerseEvent, type VerseSource } from '../src/core/verse/types.js';
import { isPersistedVerseSource } from '../src/core/verse/session-store.js';

// ---------------------------------------------------------------------------
// Helpers: run a CLI transcript through its adapter and stamp it like the engine
// ---------------------------------------------------------------------------

function stamp(turnId: string, prompt: string, parsed: VerseParsedEvent[], ok = true): VerseEvent[] {
  let seq = 0;
  const at = (n: number) => new Date(Date.UTC(2026, 8, 27, 10, 0, n)).toISOString();
  const out: VerseEvent[] = [
    { seq: ++seq, at: at(seq), type: 'user-message', turnId, text: prompt },
    { seq: ++seq, at: at(seq), type: 'turn-started', turnId, pid: 1 },
  ];
  for (const e of parsed) {
    const stamped = { ...e, seq: ++seq, at: at(seq) } as VerseEvent;
    if (!isTransientVerseEvent(stamped)) out.push(stamped);
  }
  out.push({ seq: ++seq, at: at(seq), type: 'turn-done', turnId, ok, nativeSessionId: null, durationMs: 42_000 });
  return out;
}

function anthropic(lines: readonly unknown[], engine: string): VerseParsedEvent[] {
  const parser = createAnthropicStreamParser('t1', engine, { now: () => 0 });
  const out: VerseParsedEvent[] = [];
  for (const line of lines) out.push(...parser.push(JSON.stringify(line)));
  out.push(...parser.finish(0));
  return out;
}

function codex(lines: readonly unknown[]): VerseParsedEvent[] {
  const parser = createCodexParser('t1', { now: () => 0 });
  const out: VerseParsedEvent[] = [];
  for (const line of lines) out.push(...parser.push(JSON.stringify(line)));
  out.push(...parser.finish(0));
  return out;
}

function sourcesOf(trace: VerseTraceEvent[]): VerseSource[] {
  return trace.filter((e): e is Extract<VerseTraceEvent, { type: 'source' }> => e.type === 'source').map((e) => e.source);
}

function summaryOf(trace: VerseTraceEvent[]): Extract<VerseTraceEvent, { type: 'summary' }> {
  const s = trace.find((e): e is Extract<VerseTraceEvent, { type: 'summary' }> => e.type === 'summary');
  if (!s) throw new Error('no summary');
  return s;
}

const se = (event: unknown) => ({ type: 'stream_event', event });

// ---------------------------------------------------------------------------
// Per adapter, end to end
// ---------------------------------------------------------------------------

describe('claude seat → normalized trace', () => {
  const READ_OUT = Array.from({ length: 40 }, (_, i) => `${String(i + 12).padStart(6)}→line ${i + 12}`).join('\n');
  const lines = [
    { type: 'system', subtype: 'init', session_id: 'sid', model: 'claude-opus-5-5' },
    se({ type: 'message_start', message: { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 0 } } }),
    se({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
    se({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Look at the parser first.' } }),
    se({ type: 'content_block_stop', index: 0 }),
    se({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_read', name: 'Read', input: {} } }),
    se({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/repo/src/parser.ts","offset":12,"limit":40}' } }),
    se({ type: 'content_block_stop', index: 1 }),
    se({ type: 'message_stop' }),
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_read', content: READ_OUT }] } },
    { type: 'assistant', message: { id: 'm2', model: 'claude-opus-5-5', content: [
      { type: 'tool_use', id: 'toolu_search', name: 'WebSearch', input: { query: 'vitest maxWorkers' } },
    ] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_search', content:
      'Web search results for query: "vitest maxWorkers"\n\nLinks: [{"title":"Vitest | Configuring","url":"https://vitest.dev/config/#maxworkers"},{"title":"Pools","url":"https://www.vitest.dev/guide/pools/"}]\n\nSummary…' }] } },
    { type: 'assistant', message: { id: 'm3', model: 'claude-opus-5-5', content: [
      { type: 'tool_use', id: 'toolu_fetch', name: 'WebFetch', input: { url: 'https://nodejs.org/api/fs.html#fsrealpath', prompt: 'summarize' } },
    ] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fetch', content: '# File system | Node.js v24\n\nrealpath resolves…' }] } },
    { type: 'assistant', message: { id: 'm4', model: 'claude-opus-5-5', content: [
      { type: 'tool_use', id: 'toolu_edit', name: 'Edit', input: { file_path: '/repo/src/parser.ts', old_string: 'a', new_string: 'b' } },
    ] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_edit', content: 'The file has been updated.' }] } },
    { type: 'assistant', message: { id: 'm5', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Fixed the parser.' }] } },
    { type: 'result', subtype: 'success', session_id: 'sid', usage: { input_tokens: 10, output_tokens: 20 } },
  ];

  it('derives a file source with the read range, the search and its links, and the fetched page', () => {
    const trace = normalizeVerseEvents(stamp('t1', 'fix the parser', anthropic(lines, 'claude')));
    const sources = sourcesOf(trace);
    expect(sources.map((s) => [s.kind, s.ref])).toEqual([
      ['file', '/repo/src/parser.ts'],
      ['search', 'search:vitest maxworkers'],
      ['url', 'https://vitest.dev/config'],
      ['url', 'https://www.vitest.dev/guide/pools'],
      ['url', 'https://nodejs.org/api/fs.html'],
    ]);
    expect(sources[0]).toMatchObject({ lineStart: 12, lineEnd: 51, toolUseId: 'toolu_read', origin: 'tool', title: 'parser.ts' });
    expect(sources[2]).toMatchObject({ title: 'Vitest | Configuring', domain: 'vitest.dev' });
    expect(sources[4]).toMatchObject({ title: 'File system | Node.js v24', domain: 'nodejs.org' });
  });

  it('keeps the thinking and emits one summary per turn', () => {
    const trace = normalizeVerseEvents(stamp('t1', 'fix the parser', anthropic(lines, 'claude')));
    const thinking = trace.filter((e) => e.type === 'thinking');
    expect(thinking).toEqual([expect.objectContaining({ text: 'Look at the parser first.', redacted: false, kind: 'summary' })]);
    const summary = summaryOf(trace);
    expect(summary.text).toBe('Edited 1 file · 2 web lookups');
    expect(summary.stats).toMatchObject({ filesEdited: 1, filesRead: 0, webLookups: 2, sources: 5, thoughts: 1 });
    expect(summary.durationMs).toBe(42_000);
  });
});

describe('codex seat → normalized trace', () => {
  const lines = [
    { type: 'thread.started', thread_id: 'th_1' },
    { type: 'turn.started' },
    { type: 'item.started', item: { id: 'rs_1', type: 'reasoning', text: '' } },
    { type: 'item.completed', item: { id: 'rs_1', type: 'reasoning', text: '**Reading the store** to see how events are validated.' } },
    { type: 'item.started', item: { id: 'cmd_1', type: 'command_execution', command: "bash -lc \"sed -n '240,300p' src/core/verse/session-store.ts\"", status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'cmd_1', type: 'command_execution', command: "bash -lc \"sed -n '240,300p' src/core/verse/session-store.ts\"", aggregated_output: 'function isEvent…', exit_code: 0, status: 'completed' } },
    { type: 'item.started', item: { id: 'cmd_2', type: 'command_execution', command: "bash -lc 'nl -ba src/core/verse/types.ts | sed -n '\\''600,640p'\\'''", status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'cmd_2', type: 'command_execution', command: "bash -lc 'nl -ba src/core/verse/types.ts | sed -n '\\''600,640p'\\'''", aggregated_output: '600\t…', exit_code: 0, status: 'completed' } },
    { type: 'item.started', item: { id: 'cmd_3', type: 'command_execution', command: 'bash -lc "npm test"', status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'cmd_3', type: 'command_execution', command: 'bash -lc "npm test"', aggregated_output: '1 failed', exit_code: 1, status: 'failed' } },
    { type: 'item.started', item: { id: 'ws_1', type: 'web_search', query: 'node realpath symlink' } },
    { type: 'item.completed', item: { id: 'ws_1', type: 'web_search', query: 'node realpath symlink' } },
    { type: 'item.started', item: { id: 'fc_1', type: 'file_change', changes: [{ path: 'src/core/verse/session-store.ts', kind: 'update' }], status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'fc_1', type: 'file_change', changes: [{ path: 'src/core/verse/session-store.ts', kind: 'update' }], status: 'completed' } },
    { type: 'item.completed', item: { id: 'msg_1', type: 'agent_message', text: 'Validated the new event.' } },
    { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 } },
  ];

  it('reads files out of sed / nl | sed commands, with the printed ranges', () => {
    const trace = normalizeVerseEvents(stamp('t1', 'validate it', codex(lines), false));
    const sources = sourcesOf(trace);
    expect(sources.map((s) => [s.kind, s.ref, s.lineStart, s.lineEnd])).toEqual([
      ['file', 'src/core/verse/session-store.ts', 240, 300],
      ['file', 'src/core/verse/types.ts', 600, 640],
      ['search', 'search:node realpath symlink', undefined, undefined],
    ]);
  });

  it('summarizes the turn in the operator’s words, failures included', () => {
    const summary = summaryOf(normalizeVerseEvents(stamp('t1', 'validate it', codex(lines), false)));
    expect(summary.text).toBe('Edited 1 file · ran 3 commands (1 failed) · 1 web lookup');
    expect(summary.ok).toBe(false);
    expect(summary.stats.thoughts).toBe(1);
  });
});

describe('grok seat → normalized trace', () => {
  it('reads Anthropic-wire tool calls; a bash `cat` is a read', () => {
    const lines = [
      { type: 'message_start', message: { id: 'm1', model: 'grok-4.7', content: [], usage: { input_tokens: 800, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'bash', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"cmd":"cat README.md docs/setup.md"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_stop' },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: '# Readme' }], is_error: false }] } },
    ];
    const trace = normalizeVerseEvents(stamp('t1', 'what is this', anthropic(lines, 'grok')));
    expect(sourcesOf(trace).map((s) => [s.kind, s.ref])).toEqual([['doc', 'README.md'], ['doc', 'docs/setup.md']]);
    expect(trace.filter((e) => e.type === 'thinking')).toEqual([]);
    expect(reasoningPolicyFor('grok').silentTurnNote).toBe('Reasoning not shared by this model');
  });
});

describe('local seat → normalized trace', () => {
  it('turns an inline <think> into raw reasoning and keeps the Read source', () => {
    const lines = [
      { type: 'system', subtype: 'init', session_id: 'sid', model: 'qwen3:32b' },
      se({ type: 'message_start', message: { id: 'm1', model: 'qwen3:32b', usage: { input_tokens: 10, output_tokens: 0 } } }),
      se({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '<think>Need the config.</think>\n\nReading it.' } }),
      se({ type: 'content_block_stop', index: 0 }),
      se({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/repo/vite.config.ts' } } }),
      se({ type: 'content_block_stop', index: 1 }),
      se({ type: 'message_stop' }),
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: '     1→export default {}' }] } },
    ];
    const trace = normalizeVerseEvents(stamp('t1', 'check config', anthropic(lines, 'claude')));
    expect(trace.filter((e) => e.type === 'thinking')).toEqual([expect.objectContaining({ text: 'Need the config.', kind: 'raw' })]);
    expect(sourcesOf(trace)).toEqual([expect.objectContaining({ kind: 'file', ref: '/repo/vite.config.ts', lineStart: 1, lineEnd: 1 })]);
  });
});

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

describe('tool classification', () => {
  it('strips MCP transports, both spellings', () => {
    expect(baseToolName('mcp__plugin_ashlr_ashlr__ashlr__read')).toBe('read');
    expect(baseToolName('mcp:ashlr.webfetch')).toBe('webfetch');
    expect(toolActionForName('mcp:ashlr.webfetch')).toBe('web');
    expect(toolActionForName('command_execution')).toBe('command');
    expect(toolActionForName('file_change')).toBe('edit');
    expect(toolActionForName('web_search')).toBe('web');
    expect(toolActionForName('Task')).toBe('task');
    expect(toolActionForName('SomethingNew')).toBe('other');
  });

  it('classifies memory, knowledge, wiki pages and docs by path', () => {
    expect(classifyPath('/Users/m/.ashlr/verse/memory/app-1a2b/MEMORY.md')).toBe('memory');
    expect(classifyPath('/Users/m/.ashlr/learn/knowledge/approved.json')).toBe('knowledge');
    expect(classifyPath('/Users/m/.ashlr/knowledge/wiki/repo/pages/overview.md')).toBe('doc');
    expect(classifyPath('docs/VERSE.md')).toBe('doc');
    expect(classifyPath('src/app.ts')).toBe('file');
  });
});

describe('sourcesFromToolCall', () => {
  it('a failed or unfinished call proves nothing', () => {
    expect(sourcesFromToolCall({ name: 'Read', input: { file_path: '/a.ts' }, output: 'ENOENT', isError: true })).toEqual([]);
    expect(sourcesFromToolCall({ name: 'Read', input: { file_path: '/a.ts' }, output: null, isError: false })).toEqual([]);
  });

  it('reads the range from view_range and start/end spellings; open-ended ranges stay open', () => {
    expect(sourcesFromToolCall({ name: 'str_replace_based_edit_tool', input: { command: 'view', path: '/a.ts', view_range: [5, 9] }, output: 'x', isError: false }))
      .toEqual([]); // an edit tool viewing is not classified as a read
    expect(sourcesFromToolCall({ name: 'view', input: { path: '/a.ts', view_range: [5, -1] }, output: 'x', isError: false })[0])
      .toMatchObject({ lineStart: 5 });
    expect(sourcesFromToolCall({ name: 'read_file', input: { target_file: 'b.ts', start_line: 3, end_line: 8 }, output: 'x', isError: false })[0])
      .toMatchObject({ ref: 'b.ts', lineStart: 3, lineEnd: 8 });
  });

  it('never keeps credentials in a URL, and ignores non-http schemes', () => {
    expect(normalizeUrl('https://user:secret@example.com/a/?q=1#frag')).toEqual({ url: 'https://example.com/a/?q=1', domain: 'example.com' });
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(sourcesFromToolCall({ name: 'WebFetch', input: { url: 'file:///etc/passwd' }, output: 'x', isError: false })).toEqual([]);
  });

  it('falls back to markdown links in a search result', () => {
    const out = sourcesFromToolCall({ name: 'ashlr__websearch', input: { query: 'x' }, output: '1. [Title A](https://a.dev/x)\n2. [B](https://b.dev)', isError: false });
    expect(out.map((s) => s.ref)).toEqual(['search:x', 'https://a.dev/x', 'https://b.dev']);
  });
});

describe('shellReads', () => {
  it('handles the viewing commands codex actually runs', () => {
    expect(shellReads(['bash', '-lc', "sed -n '1,120p' src/a.ts"])).toEqual([{ path: 'src/a.ts', range: { start: 1, end: 120 } }]);
    expect(shellReads('head -n 30 README.md && cat package.json')).toEqual([
      { path: 'README.md', range: { start: 1, end: 30 } },
      { path: 'package.json', range: null },
    ]);
    expect(shellReads("/bin/zsh -lc 'sed -n 12p src/b.ts'")).toEqual([{ path: 'src/b.ts', range: { start: 12, end: 12 } }]);
  });

  it('does not treat searches, globs or redirections as reads', () => {
    expect(shellReads('rg -n "isEvent" src')).toEqual([]);
    expect(shellReads('cat src/*.ts')).toEqual([]);
    expect(shellReads('cat > out.txt')).toEqual([]);
    expect(shellReads('cat a.ts > b.ts 2>&1')).toEqual([{ path: 'a.ts', range: null }]);
    expect(shellReads('ls -la && git status')).toEqual([]);
  });
});

describe('citations', () => {
  const file = (ref: string, lineStart?: number, lineEnd?: number, toolUseId = 't'): VerseSource => ({
    kind: 'file', ref, title: ref, origin: 'tool', path: ref, toolUseId,
    ...(lineStart !== undefined ? { lineStart } : {}), ...(lineEnd !== undefined ? { lineEnd } : {}),
  });

  it('numbers in order of first use and de-duplicates by ref', () => {
    const cited = collateSources([file('a.ts', 1, 10, 'x'), file('b.ts', 5, 6), file('a.ts', 40, 50, 'y'), file('a.ts', 8, 20, 'z')]);
    expect(cited.map((c) => [c.n, c.source.ref, formatRanges(c.ranges), c.count, c.toolUseIds])).toEqual([
      [1, 'a.ts', '1-20, 40-50', 3, ['x', 'y', 'z']],
      [2, 'b.ts', '5-6', 1, ['t']],
    ]);
  });

  it('a whole-file read anywhere cites the whole file', () => {
    expect(collateSources([file('a.ts', 1, 10), file('a.ts')])[0]!.ranges).toEqual([]);
  });

  it('merges adjacent and open-ended ranges', () => {
    expect(mergeRanges([{ start: 1, end: 5 }, { start: 6, end: 9 }, { start: 20, end: null }, { start: 25, end: 30 }]))
      .toEqual([{ start: 1, end: 9 }, { start: 20, end: null }]);
    expect(formatRanges([{ start: 20, end: null }, { start: 7, end: 7 }])).toBe('20+, 7');
  });
});

describe('describeTurnWork', () => {
  it('is empty for a plain answer and names every clause with its noun', () => {
    expect(describeTurnWork(emptyTurnStats())).toBe('');
    expect(describeTurnWork({ ...emptyTurnStats(), filesRead: 8, filesEdited: 3, additions: 42, deletions: 7, commands: 4, commandsFailed: 1, subagents: 1, codeSearches: 2 }))
      .toBe('Read 8 files · edited 3 files (+42 −7) · ran 4 commands (1 failed) · searched the code 2× · ran 1 subagent');
  });
});

describe('the write side: a new seat emits the normalized schema', () => {
  it('lowers to the persisted events every client renders; derived things are not persisted', () => {
    const trace: VerseTraceEvent[] = [
      { type: 'thinking', turnId: 't', text: 'plan', redacted: false, durationMs: 1200.4, kind: 'summary' },
      { type: 'thinking', turnId: 't', text: 'secret', redacted: true, durationMs: null, kind: null },
      { type: 'tool-call', turnId: 't', callId: 'c1', tool: 'Read', action: 'read', input: { file_path: '/a.ts' } },
      { type: 'tool-result', turnId: 't', callId: 'c1', output: 'x', isError: false },
      { type: 'source', turnId: 't', source: { kind: 'file', ref: '/a.ts', title: 'a.ts', origin: 'tool' } },
      { type: 'source', turnId: 't', source: { kind: 'url', ref: 'https://docs.devin.ai', title: 'Devin docs', origin: 'agent', url: 'https://docs.devin.ai' } },
      { type: 'summary', turnId: 't', text: 'x', stats: emptyTurnStats(), ok: true, durationMs: null },
    ];
    expect(trace.flatMap(lowerTraceEvent)).toEqual([
      { type: 'thinking', turnId: 't', text: 'plan', durationMs: 1200, kind: 'summary' },
      { type: 'thinking', turnId: 't', text: '', redacted: true },
      { type: 'tool-use', turnId: 't', toolUseId: 'c1', name: 'Read', input: { file_path: '/a.ts' } },
      { type: 'tool-result', turnId: 't', toolUseId: 'c1', output: 'x', isError: false },
      { type: 'source', turnId: 't', source: { kind: 'url', ref: 'https://docs.devin.ai', title: 'Devin docs', origin: 'agent', url: 'https://docs.devin.ai' } },
    ]);
  });

  it('a persisted source reads back as a source and counts toward the turn', () => {
    const events: VerseEvent[] = [
      { seq: 1, at: 'a', type: 'user-message', turnId: 't', text: 'go' },
      { seq: 2, at: 'b', type: 'source', turnId: 't', source: { kind: 'knowledge', ref: 'k:1', title: 'Run the tests before a merge', origin: 'engine' } },
      { seq: 3, at: 'c', type: 'turn-done', turnId: 't', ok: true, nativeSessionId: null, durationMs: 0 },
    ];
    const trace = normalizeVerseEvents(events);
    expect(sourcesOf(trace)).toHaveLength(1);
    expect(summaryOf(trace).stats.sources).toBe(1);
    expect(summaryOf(trace).durationMs).toBeNull();
  });
});

describe('isVerseSource', () => {
  it('agrees with the session store’s own copy of the check', () => {
    const cases: unknown[] = [
      { kind: 'url', ref: 'https://a.dev', title: 'A', origin: 'agent', url: 'https://a.dev', domain: 'a.dev' },
      { kind: 'file', ref: 'a.ts', title: 'a.ts', origin: 'tool', lineStart: 3, lineEnd: 9 },
      { kind: 'secret', ref: 'x', title: 'x', origin: 'tool' },
      { kind: 'file', ref: '', title: 'x', origin: 'tool' },
      { kind: 'file', ref: 'a', title: 'x', origin: 'model' },
      { kind: 'file', ref: 'a', title: 'x', origin: 'tool', lineStart: 1.5 },
      { kind: 'file', ref: 'a', title: 'x', origin: 'tool', detail: 'y'.repeat(2000) },
      { kind: 'memory', ref: 'm', title: 7, origin: 'engine' },
      null, 'source', [],
    ];
    for (const c of cases) expect(isPersistedVerseSource(c)).toBe(isVerseSource(c));
  });

  it('accepts a well-formed source and drops malformed ones', () => {
    expect(isVerseSource({ kind: 'url', ref: 'https://a.dev', title: 'A', origin: 'agent', url: 'https://a.dev', domain: 'a.dev' })).toBe(true);
    expect(isVerseSource({ kind: 'file', ref: 'a.ts', title: 'a.ts', origin: 'tool', lineStart: 3, lineEnd: 9 })).toBe(true);
    expect(isVerseSource({ kind: 'secret', ref: 'x', title: 'x', origin: 'tool' })).toBe(false);
    expect(isVerseSource({ kind: 'file', ref: '', title: 'x', origin: 'tool' })).toBe(false);
    expect(isVerseSource({ kind: 'file', ref: 'a', title: 'x', origin: 'model' })).toBe(false);
    expect(isVerseSource({ kind: 'file', ref: 'a', title: 'x', origin: 'tool', lineStart: 0 })).toBe(false);
    expect(isVerseSource(null)).toBe(false);
  });
});

describe('reasoningPolicyFor', () => {
  it('says something only where silence would mislead', () => {
    expect(reasoningPolicyFor('claude')).toEqual({ visibility: 'summary', silentTurnNote: null });
    expect(reasoningPolicyFor('local').silentTurnNote).toBeNull();
    expect(reasoningPolicyFor('codex').silentTurnNote).toMatch(/no reasoning summary/i);
    expect(reasoningPolicyFor('devin')).toEqual({ visibility: 'hidden', silentTurnNote: 'Reasoning not shared by this seat' });
  });
});
