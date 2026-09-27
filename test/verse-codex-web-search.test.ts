/**
 * test/verse-codex-web-search.test.ts — codex `web_search` items become
 * `tool-use` / `tool-result` pairs (they used to be dropped), in both the
 * older `{query}` shape and the newer `action:{type,…}` shape.
 */
import { describe, expect, it } from 'vitest';

import type { VerseParsedEvent } from '../src/core/verse/adapters/index.js';
import { createCodexParser } from '../src/core/verse/adapters/codex.js';

function run(lines: readonly unknown[]): VerseParsedEvent[] {
  const parser = createCodexParser('t');
  const out: VerseParsedEvent[] = [];
  for (const line of lines) out.push(...parser.push(JSON.stringify(line)));
  out.push(...parser.finish(0));
  return out;
}

function ofType<T extends VerseParsedEvent['type']>(events: VerseParsedEvent[], type: T): Array<Extract<VerseParsedEvent, { type: T }>> {
  return events.filter((e): e is Extract<VerseParsedEvent, { type: T }> => e.type === type);
}

describe('codex parser — web_search items', () => {
  it('older builds: `{query}` on started + completed → one tool-use, one Searched: result, tool phase', () => {
    const events = run([
      { type: 'thread.started', thread_id: '01a0d0d6-088c-7282-957a-f6fad627f77e' },
      { type: 'turn.started' },
      { type: 'item.started', item: { id: 'ws_1', type: 'web_search', query: 'vitest maxWorkers' } },
      { type: 'item.completed', item: { id: 'ws_1', type: 'web_search', query: 'vitest maxWorkers' } },
      { type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'Use --maxWorkers=2.' } },
    ]);
    expect(ofType(events, 'tool-use')).toEqual([
      { type: 'tool-use', turnId: 't', toolUseId: 'ws_1', name: 'web_search', input: { query: 'vitest maxWorkers' } },
    ]);
    expect(ofType(events, 'tool-result')).toEqual([
      { type: 'tool-result', turnId: 't', toolUseId: 'ws_1', output: 'Searched: vitest maxWorkers', isError: false },
    ]);
    const progress = ofType(events, 'progress');
    expect(progress.some((p) => p.phase === 'tool' && p.tool === 'web_search')).toBe(true);
    expect(events.map((e) => e.type).filter((t) => t !== 'progress')).toEqual(['tool-use', 'tool-result', 'assistant-message']);
  });

  it('newer builds: action search / open_page / find_in_page, input carries only present keys', () => {
    const events = run([
      { type: 'item.started', item: { id: 'ws_a', type: 'web_search', query: '', action: { type: 'search', query: 'node 24 release date' } } },
      { type: 'item.completed', item: { id: 'ws_a', type: 'web_search', query: 'node 24 release date', action: { type: 'search', query: 'node 24 release date' } } },
      { type: 'item.completed', item: { id: 'ws_b', type: 'web_search', action: { type: 'open_page', url: 'https://nodejs.org/en/blog' } } },
      { type: 'item.completed', item: { id: 'ws_c', type: 'web_search', action: { type: 'find_in_page', url: 'https://nodejs.org/en/blog', pattern: 'v24' } } },
    ]);
    expect(ofType(events, 'tool-use').map((e) => [e.toolUseId, e.input])).toEqual([
      ['ws_a', { query: 'node 24 release date', action: 'search' }],
      ['ws_b', { url: 'https://nodejs.org/en/blog', action: 'open_page' }],
      ['ws_c', { url: 'https://nodejs.org/en/blog', action: 'find_in_page' }],
    ]);
    expect(ofType(events, 'tool-result').map((e) => [e.toolUseId, e.output, e.isError])).toEqual([
      ['ws_a', 'Searched: node 24 release date', false],
      ['ws_b', 'Opened: https://nodejs.org/en/blog', false],
      ['ws_c', 'Searched https://nodejs.org/en/blog for: v24', false],
    ]);
  });

  it('a failed search is an error result; an empty started item gives an empty input', () => {
    const events = run([
      { type: 'item.started', item: { id: 'ws_x', type: 'web_search', query: '' } },
      { type: 'item.completed', item: { id: 'ws_x', type: 'web_search', query: 'offline?', status: 'failed' } },
    ]);
    expect(ofType(events, 'tool-use')).toEqual([
      { type: 'tool-use', turnId: 't', toolUseId: 'ws_x', name: 'web_search', input: {} },
    ]);
    expect(ofType(events, 'tool-result')).toEqual([
      { type: 'tool-result', turnId: 't', toolUseId: 'ws_x', output: 'Searched: offline?', isError: true },
    ]);
  });

  it('file_change tool-use input is still {changes:[{path, kind}]}', () => {
    const changes = [{ path: '/tmp/proj/a.ts', kind: 'update' }];
    const events = run([{ type: 'item.completed', item: { id: 'fc_1', type: 'file_change', status: 'completed', changes } }]);
    expect(ofType(events, 'tool-use')[0]).toMatchObject({ name: 'file_change', input: { changes } });
  });
});
