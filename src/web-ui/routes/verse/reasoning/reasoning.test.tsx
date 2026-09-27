/**
 * reasoning/reasoning.test.tsx — the chat-level Sources and Reasoning models
 * and the registry-mountable panes (V3.15).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { VerseEvent } from '../../../data/api-types.js';
import { buildTurns, createTurnCache } from '../chat/turn-model.js';
import { foldReadRuns } from '../chat/activity-model.js';
import { ev, session } from '../fixtures.test-support.js';
import { resetVerseStore, seedVerseSession } from '../verse-store.js';
import { buildTranscript, groupTranscriptItems, type ToolGroupItem } from '../verse-transcript.js';
import { REASONING_PANES } from './pane-adapter.js';
import { buildChatSources, buildReasoningTrail, injectedSources, reasoningTotals } from './reasoning-model.js';
import { SourcesPane } from './SourcesPanel.js';
import { ReasoningPane } from './ReasoningPanel.js';

function turnsOf(events: VerseEvent[]) {
  return buildTurns(groupTranscriptItems(buildTranscript(events).items), createTurnCache()).turns;
}

const read = (seq: number, turnId: string, id: string, path: string, offset?: number, limit?: number): VerseEvent[] => [
  ev(seq, 'tool-use', { turnId, toolUseId: id, name: 'Read', input: { file_path: path, ...(offset ? { offset } : {}), ...(limit ? { limit } : {}) } }),
  ev(seq + 1, 'tool-result', { turnId, toolUseId: id, output: 'x', isError: false }),
];

const LOG: VerseEvent[] = [
  ev(1, 'user-message', { turnId: 't1', text: 'where is the parser' }),
  ev(2, 'thinking', { turnId: 't1', text: 'Look in src.', durationMs: 2000 }),
  ...read(3, 't1', 'a', '/r/src/parser.ts', 1, 20),
  ...read(5, 't1', 'b', '/r/README.md'),
  ev(7, 'turn-done', { turnId: 't1', ok: true, nativeSessionId: null, durationMs: 1000 }),
  ev(8, 'user-message', { turnId: 't2', text: 'and the tests' }),
  ev(9, 'thinking', { turnId: 't2', text: '', redacted: true }),
  ...read(10, 't2', 'c', '/r/src/parser.ts', 40, 10),
  ...read(12, 't2', 'd', '/r/test/parser.test.ts'),
  ev(14, 'turn-done', { turnId: 't2', ok: true, nativeSessionId: null, durationMs: 1000 }),
];

afterEach(() => resetVerseStore());

describe('turn citations', () => {
  it('numbers per turn and merges a file’s ranges within the turn', () => {
    const turns = turnsOf(LOG);
    expect(turns.map((t) => t.citations.map((c) => [c.n, c.source.ref]))).toEqual([
      [[1, '/r/src/parser.ts'], [2, '/r/README.md']],
      [[1, '/r/src/parser.ts'], [2, '/r/test/parser.test.ts']],
    ]);
    expect(turns[0]!.citations[1]!.source.kind).toBe('doc');
    expect(turns[0]!.reasoning).toEqual({ shown: 1, hidden: 0, durationMs: 2000, tokens: 3 });
    expect(turns[1]!.reasoning).toMatchObject({ shown: 0, hidden: 1, durationMs: null, tokens: null });
  });
});

describe('buildChatSources', () => {
  it('de-duplicates across turns, merges ranges, and names the turns that cited each', () => {
    const turns = turnsOf(LOG);
    const { entries, byKind } = buildChatSources(turns);
    expect(entries.map((e) => [e.citation.n, e.citation.source.ref, e.turnKeys.length])).toEqual([
      [1, '/r/src/parser.ts', 2],
      [2, '/r/README.md', 1],
      [3, '/r/test/parser.test.ts', 1],
    ]);
    expect(entries[0]!.citation.ranges).toEqual([{ start: 1, end: 20 }, { start: 40, end: 49 }]);
    expect(byKind).toMatchObject({ file: 2, doc: 1 });
  });

  it('lists shared project memory Verse injected, first', () => {
    const injected = injectedSources({ memoryEnabled: true, projectPath: '/r' });
    const { entries } = buildChatSources(turnsOf(LOG), injected);
    expect(entries[0]!.citation.source).toMatchObject({ kind: 'memory', origin: 'engine' });
    expect(injectedSources({ memoryEnabled: false, projectPath: '/r' })).toEqual([]);
  });
});

describe('buildReasoningTrail', () => {
  it('lines up each turn’s thoughts and totals them', () => {
    const trail = buildReasoningTrail(turnsOf(LOG), 'claude');
    expect(trail.map((e) => [e.index, e.title, e.thoughts.length, e.silentNote])).toEqual([
      [1, 'where is the parser', 1, null],
      [2, 'and the tests', 1, null],
    ]);
    expect(reasoningTotals(trail)).toEqual({ shown: 1, hidden: 1, durationMs: 2000, tokens: 3 });
  });

  it('says a hidden-reasoning seat shared nothing, on settled turns only', () => {
    const turns = turnsOf([
      ev(1, 'user-message', { turnId: 't1', text: 'hi' }),
      ev(2, 'turn-done', { turnId: 't1', ok: true, nativeSessionId: null, durationMs: 1 }),
      ev(3, 'user-message', { turnId: 't2', text: 'again' }),
    ]);
    expect(buildReasoningTrail(turns, 'grok').map((e) => e.silentNote)).toEqual(['Reasoning not shared by this model', null]);
  });
});

describe('foldReadRuns', () => {
  it('folds consecutive clean reads; a failed read and other calls break the run', () => {
    const events: VerseEvent[] = [
      ev(1, 'user-message', { turnId: 't', text: 'x' }),
      ...read(2, 't', 'r1', '/a'),
      ...read(4, 't', 'r2', '/b'),
      ev(6, 'tool-use', { turnId: 't', toolUseId: 'r3', name: 'Read', input: { file_path: '/c' } }),
      ev(7, 'tool-result', { turnId: 't', toolUseId: 'r3', output: 'ENOENT', isError: true }),
      ...read(8, 't', 'r4', '/d'),
    ];
    const group = groupTranscriptItems(buildTranscript(events).items).find((i) => i.kind === 'toolGroup') as ToolGroupItem;
    const rows = foldReadRuns(group.items);
    expect(rows.map((r) => (r.kind === 'reads' ? `reads:${r.members.length}` : r.member.key))).toEqual(['reads:2', 'tu-6', 'tu-8']);
  });
});

describe('registry panes', () => {
  it('describes both panes with lazy loaders', async () => {
    expect(REASONING_PANES.map((p) => p.id)).toEqual(['sources', 'reasoning']);
    const mod = await REASONING_PANES[0]!.load();
    expect(mod.default).toBe(SourcesPane);
  });

  it('SourcesPane and ReasoningPane need nothing but the session id', async () => {
    const user = userEvent.setup();
    seedVerseSession('s1', session({ id: 's1', engine: 'grok', memoryEnabled: true, projectPath: '/r' }), LOG);
    const { unmount } = render(<SourcesPane sessionId="s1" />);
    expect(screen.getByText('Shared project memory (MEMORY.md)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^All 4/ })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: /^Docs & memory 2/ }));
    expect(document.querySelectorAll('li[data-kind]')).toHaveLength(2);
    await user.type(screen.getByRole('searchbox', { name: 'Filter sources' }), 'readme');
    expect(document.querySelectorAll('li[data-kind]')).toHaveLength(1);
    unmount();

    render(<ReasoningPane sessionId="s1" />);
    const turn2 = screen.getByRole('button', { name: /Turn 2: and the tests/ });
    expect(within(turn2.closest('li')!).getByText(/reasoning hidden by the provider/)).toBeInTheDocument();
  });
});
