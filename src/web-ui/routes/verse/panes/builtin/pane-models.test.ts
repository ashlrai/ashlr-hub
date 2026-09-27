/**
 * panes/builtin/pane-models.test.ts — what the stub Files, Sources and
 * Reasoning panes derive from a chat's transcript.
 */
import { describe, expect, it } from 'vitest';
import { ev } from '../../fixtures.test-support.js';
import { buildTranscript } from '../../verse-transcript.js';
import { chatSources, reasoningByTurn, touchedFiles } from './pane-models.js';

const items = buildTranscript([
  ev(1, 'user-message', { turnId: 't1', text: 'Fix the login bug\nand add a test' }),
  ev(2, 'thinking', { turnId: 't1', text: 'The session cookie is not refreshed.' }),
  ev(3, 'tool-use', { turnId: 't1', toolUseId: 'r1', name: 'Read', input: { file_path: '/repo/src/auth.ts' } }),
  ev(4, 'tool-result', { turnId: 't1', toolUseId: 'r1', output: 'ok', isError: false }),
  ev(5, 'tool-use', { turnId: 't1', toolUseId: 'e1', name: 'Edit', input: { file_path: '/repo/src/auth.ts', old_string: 'a', new_string: 'b' } }),
  ev(6, 'tool-result', { turnId: 't1', toolUseId: 'e1', output: 'ok', isError: false }),
  ev(7, 'tool-use', { turnId: 't1', toolUseId: 'w1', name: 'Write', input: { file_path: '/repo/src/auth.test.ts', content: '…' } }),
  ev(8, 'tool-result', { turnId: 't1', toolUseId: 'w1', output: 'boom', isError: true }),
  ev(9, 'tool-use', { turnId: 't1', toolUseId: 'f1', name: 'WebFetch', input: { url: 'https://example.com/docs', prompt: 'read' } }),
  ev(10, 'tool-result', { turnId: 't1', toolUseId: 'f1', output: 'ok', isError: false }),
  ev(11, 'tool-use', { turnId: 't1', toolUseId: 's1', name: 'WebSearch', input: { query: 'cookie refresh' } }),
  ev(12, 'tool-result', { turnId: 't1', toolUseId: 's1', output: 'ok', isError: false }),
  ev(13, 'turn-done', { turnId: 't1', ok: true, nativeSessionId: null, durationMs: 1000 }),
  ev(14, 'user-message', { turnId: 't2', text: 'Thanks' }),
  ev(15, 'thinking', { turnId: 't2', text: 'Nothing to do.' }),
]).items;

describe('touchedFiles', () => {
  it('lists each file once, with the strongest thing done to it, changed files first', () => {
    const files = touchedFiles(items);
    expect(files.map((f) => [f.path, f.touch, f.count])).toEqual([['/repo/src/auth.ts', 'edited', 2]]);
    // A failed write changed nothing, so it is not listed as created.
    expect(files.some((f) => f.path.endsWith('auth.test.ts'))).toBe(false);
  });
});

describe('chatSources', () => {
  it('lists pages fetched, searches and files read — a link only for http(s)', () => {
    const sources = chatSources(items);
    expect(sources.map((s) => [s.kind, s.target, s.href !== null])).toEqual(expect.arrayContaining([
      ['web', 'https://example.com/docs', true],
      ['search', 'cookie refresh', false],
      ['file', '/repo/src/auth.ts', false],
    ]));
    expect(new Set(sources.map((s) => s.key)).size).toBe(sources.length);
  });
});

describe('reasoningByTurn', () => {
  it('groups thinking by turn, newest turn first, with the first line of the ask', () => {
    const turns = reasoningByTurn(items);
    expect(turns.map((t) => [t.turnId, t.ask, t.blocks.length])).toEqual([
      ['t2', 'Thanks', 1],
      ['t1', 'Fix the login bug', 1],
    ]);
  });
});
