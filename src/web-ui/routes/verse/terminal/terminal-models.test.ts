/**
 * 3.15 Terminal panel — the pure parts: file links, ligatures, ANSI spans,
 * block model (terminal + agent blocks, chat text), the split/tab layout and
 * its persistence, the panel's keys, and the stream parser for block frames.
 */
import { describe, expect, it } from 'vitest';
import type { VerseTerminalBlock } from '../../../data/api-types.js';
import type { TranscriptItem } from '../verse-transcript.js';
import { applySgr, color256, parseAnsi, runCss } from './ansi-spans.js';
import {
  agentBlocksFromTranscript,
  blockChatText,
  blockStatus,
  fenceFor,
  formatDuration,
  tailForChat,
  terminalBlockView,
  upsertBlock,
  CHAT_OUTPUT_MAX_LINES,
} from './blocks-model.js';
import { findFileLinks } from './file-links.js';
import {
  addGroup,
  AGENT_GROUP_ID,
  EMPTY_LAYOUT,
  focusPane,
  layoutStorageKey,
  loadLayout,
  MAX_PANES_PER_GROUP,
  arrangementAfterSplit,
  cyclePane,
  gridShape,
  neighborPane,
  nextArrangement,
  paneCells,
  setArrangement,
  toggleZoom,
  parseLayout,
  reconcileLayout,
  removePane,
  saveLayout,
  setMode,
  splitGroup,
} from './layout-model.js';
import { ligatureRanges } from './ligatures.js';
import { keyPassesToPage, panelKeyAction } from './panel-keys.js';
import { parsePanelSseBlock } from './panel-stream.js';
import { rgbToHex } from './xterm-view.js';

// ---------------------------------------------------------------------------

describe('file:line links', () => {
  const paths = (text: string) => findFileLinks(text).map((l) => [l.path, l.line, l.column]);

  it('finds compiler, test-runner and stack-trace references', () => {
    expect(paths('src/app.ts:12:5 - error TS2322')).toEqual([['src/app.ts', 12, 5]]);
    expect(paths('  at run (/Users/me/proj/lib/x.js:10:15)')).toEqual([['/Users/me/proj/lib/x.js', 10, 15]]);
    expect(paths('src/app.ts(12,5): error')).toEqual([['src/app.ts', 12, 5]]);
    expect(paths('FAIL ./test/a.test.ts:3')).toEqual([['./test/a.test.ts', 3, null]]);
    expect(paths('see ~/code/p/y.rs:4:2 and ../z.go:9')).toEqual([['~/code/p/y.rs', 4, 2], ['../z.go', 9, null]]);
    expect(paths('  File "/usr/lib/x.py", line 12, in f')).toEqual([['/usr/lib/x.py', 12, null]]);
    expect(paths('modified: src/components/Button.tsx')).toEqual([['src/components/Button.tsx', null, null]]);
  });

  it('leaves prose, versions and URLs alone', () => {
    expect(findFileLinks('built with node.js v1.2.3 in 3.14 s')).toEqual([]);
    expect(findFileLinks('open https://example.com/a/b.js:12 now')).toEqual([]);
    expect(findFileLinks('package.json')).toEqual([]);
  });

  it('reports exact ranges', () => {
    const [link] = findFileLinks('x src/a.ts:1 y');
    expect(link).toMatchObject({ start: 2, end: 12 });
  });
});

describe('ligatures', () => {
  it('joins programming ligature runs, longest first', () => {
    expect(ligatureRanges('a => b')).toEqual([[2, 4]]);
    expect(ligatureRanges('x === y !== z')).toEqual([[2, 5], [8, 11]]);
    expect(ligatureRanges('0xFF but 0x not')).toEqual([[0, 2]]);
    expect(ligatureRanges('plain words')).toEqual([]);
  });
});

describe('ANSI → styled runs', () => {
  it('keeps 16, 256 and RGB colours, bold, and resets', () => {
    const runs = parseAnsi('\x1b[1;31mERR\x1b[0m ok \x1b[38;5;196mhot\x1b[38;2;1;2;3mrgb\x1b[39m');
    expect(runs.map((r) => r.text)).toEqual(['ERR', ' ok ', 'hot', 'rgb']);
    expect(runs[0]!.style).toEqual({ bold: true, fg: 'var(--term-red)' });
    expect(runs[1]!.style).toEqual({});
    expect(runs[2]!.style.fg).toBe('rgb(255, 0, 0)');
    expect(runs[3]!.style.fg).toBe('rgb(1, 2, 3)');
  });

  it('drops cursor motion and OSC strings, and shows a progress bar\'s last drawing', () => {
    const runs = parseAnsi('\x1b]0;title\x07\x1b[2K 10%\r 55%\r100%\ndone\x1b[K\n\n');
    expect(runs.map((r) => r.text).join('')).toBe('100%\ndone');
  });

  it('maps bright colours and the 256 grey ramp', () => {
    expect(applySgr({}, [92]).fg).toBe('var(--term-bright-green)');
    expect(color256(232)).toBe('rgb(8, 8, 8)');
    expect(color256(9)).toBe('var(--term-bright-red)');
  });

  it('inverse swaps against the terminal\'s colours', () => {
    expect(runCss({ inverse: true })).toEqual({ color: 'var(--term-bg)', backgroundColor: 'var(--term-fg)' });
  });
});

// ---------------------------------------------------------------------------

function block(over: Partial<VerseTerminalBlock> = {}): VerseTerminalBlock {
  return {
    id: 'b-1', tabId: 't-1', command: 'npm test', cwd: '~/proj', startedAt: '2026-09-27T10:00:00.000Z',
    finishedAt: null, durationMs: null, exitCode: null, state: 'running', startSeq: 3, ordinal: 0,
    outputBytes: 0, truncated: false, evicted: false, fullscreen: false, ...over,
  };
}

function toolItem(id: string, name: string, input: unknown, result: { output: string; isError: boolean } | null, durationMs: number | null = 1200): TranscriptItem {
  return { kind: 'tool', key: id, turnId: 'turn-1', at: '2026-09-27T10:00:00.000Z', toolUseId: id, name, input, result, durationMs };
}

describe('blocks', () => {
  it('a block frame is merged by id (started, then finished), in order', () => {
    let list = upsertBlock([], block({ id: 'b-2' }));
    list = upsertBlock(list, block({ id: 'b-1' }));
    list = upsertBlock(list, block({ id: 'b-2', state: 'done', exitCode: 1 }));
    expect(list.map((b) => [b.id, b.state])).toEqual([['b-1', 'running'], ['b-2', 'done']]);
  });

  it('says how a block ended — never invents an exit code', () => {
    expect(blockStatus(terminalBlockView(block()))).toEqual({ tone: 'running', label: 'Running' });
    expect(blockStatus(terminalBlockView(block({ state: 'done', exitCode: 0 })))).toEqual({ tone: 'ok', label: 'Exit 0' });
    expect(blockStatus(terminalBlockView(block({ state: 'done', exitCode: 2 })))).toEqual({ tone: 'error', label: 'Exit 2' });
    expect(blockStatus(terminalBlockView(block({ state: 'done', exitCode: null })))).toEqual({ tone: 'unknown', label: 'Done' });
    expect(formatDuration(850)).toBe('850 ms');
    expect(formatDuration(12_500)).toBe('13 s');
    expect(formatDuration(125_000)).toBe('2 m 5 s');
  });

  it('agent blocks: every shell tool call in the transcript, with its output — nothing else', () => {
    const items: TranscriptItem[] = [
      { kind: 'text', key: 'x', turnId: 'turn-1', at: '2026-09-27T10:00:00.000Z', text: 'hi' } as unknown as TranscriptItem,
      toolItem('tu-1', 'Bash', { command: 'npm test', description: 'run tests' }, { output: 'FAIL a.test.ts\nexit code 1', isError: true }),
      toolItem('tu-2', 'Read', { file_path: '/x/a.ts' }, { output: 'code', isError: false }),
      toolItem('tu-3', 'command_execution', { command: 'ls -la', cwd: '/Users/me/proj' }, { output: 'a\nb', isError: false }),
      toolItem('tu-4', 'Bash', { command: 'sleep 5' }, null, null),
    ];
    const blocks = agentBlocksFromTranscript(items);
    expect(blocks.map((b) => [b.id, b.command, b.failed, b.running, b.cwd])).toEqual([
      ['tu-1', 'npm test', true, false, null],
      ['tu-3', 'ls -la', false, false, '/Users/me/proj'],
      ['tu-4', 'sleep 5', false, true, null],
    ]);
    expect(blocks[0]).toMatchObject({ source: 'agent', output: 'FAIL a.test.ts\nexit code 1', tool: 'Bash', durationMs: 1200 });
  });

  it('chat text: fenced so the output cannot close it, tail-cut, and "explain" asks for a fix without running anything', () => {
    const view = terminalBlockView(block({ state: 'done', exitCode: 1 }));
    const text = blockChatText(view, 'npm test', 'boom ``` here', 'explain');
    expect(text).toContain('I ran this in my terminal in `~/proj` (exit 1)');
    expect(text).toContain("don't run anything yet");
    expect(text).toContain('````console\n$ npm test\nboom ``` here\n````');
    expect(fenceFor('a ```` b')).toBe('`````');
    const long = Array.from({ length: CHAT_OUTPUT_MAX_LINES + 50 }, (_, i) => `line ${i}`).join('\n');
    const cut = tailForChat(long);
    expect(cut.cut).toBe(true);
    expect(cut.text.startsWith('line 50\n')).toBe(true);
    expect(blockChatText({ ...view, source: 'agent' }, 'x', long, 'send')).toContain('_(output cut to its last lines)_');
  });
});

// ---------------------------------------------------------------------------

describe('layout: tabs and splits', () => {
  it('reconciles with the shells that exist: new ones get a tab, gone ones leave, the active tab stays valid', () => {
    const start = parseLayout(JSON.stringify({ groups: [{ id: 'g1', panes: ['t-a', 't-b'], direction: 'row', focused: 't-b' }, { id: 'g2', panes: ['t-gone'], direction: 'row', focused: 't-gone' }], active: 'g2', modes: { 't-a': 'blocks', 't-gone': 'blocks' } }));
    const next = reconcileLayout(start, ['t-a', 't-b', 't-c']);
    expect(next.groups.map((g) => g.panes)).toEqual([['t-a', 't-b'], ['t-c']]);
    expect(next.active).toBe(next.groups[1]!.id);
    expect(next.modes).toEqual({ 't-a': 'blocks' });
    // Unchanged input comes back as the same object (no render loop).
    expect(reconcileLayout(next, ['t-a', 't-b', 't-c'])).toBe(next);
  });

  it('splits hold up to six shells (one multiplexed stream carries them); closing one hands focus to its neighbour; an empty tab goes', () => {
    let l = addGroup(EMPTY_LAYOUT, 't-a');
    const g = l.groups[0]!.id;
    l = splitGroup(l, g, 't-b', 'column')!;
    expect(l.groups[0]).toMatchObject({ panes: ['t-a', 't-b'], direction: 'column', focused: 't-b' });
    expect(MAX_PANES_PER_GROUP).toBe(6);
    // Splitting the other way tiles the group.
    l = splitGroup(l, g, 't-c', 'row')!;
    expect(l.groups[0]).toMatchObject({ panes: ['t-a', 't-b', 't-c'], direction: 'grid', focused: 't-c' });
    for (const id of ['t-d', 't-e', 't-f']) l = splitGroup(l, g, id, 'row')!;
    expect(l.groups[0]!.panes).toHaveLength(6);
    expect(splitGroup(l, g, 't-g', 'row')).toBeNull();
    for (const id of ['t-c', 't-d', 't-e', 't-f']) l = removePane(l, id);
    l = removePane(l, 't-b');
    expect(l.groups[0]).toMatchObject({ panes: ['t-a'], focused: 't-a' });
    l = removePane(l, 't-a');
    expect(l.groups).toEqual([]);
    expect(l.active).toBeNull();
  });

  it('grids: ⌈√n⌉ columns, a short last row stretches, arrows find the neighbour in any arrangement', () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => gridShape(n))).toEqual([
      { cols: 1, rows: 1 }, { cols: 2, rows: 1 }, { cols: 2, rows: 2 }, { cols: 2, rows: 2 }, { cols: 3, rows: 2 }, { cols: 3, rows: 2 },
    ]);
    const three = { panes: ['a', 'b', 'c'], direction: 'grid' as const };
    expect(paneCells(three)).toEqual([
      { id: 'a', row: 0, col: 0, span: 1 }, { id: 'b', row: 0, col: 1, span: 1 }, { id: 'c', row: 1, col: 0, span: 2 },
    ]);
    expect(neighborPane(three, 'a', 'right')).toBe('b');
    expect(neighborPane(three, 'b', 'down')).toBe('c');
    expect(neighborPane(three, 'c', 'up')).toBe('a');
    expect(neighborPane(three, 'a', 'left')).toBeNull();
    const six = { panes: ['a', 'b', 'c', 'd', 'e', 'f'], direction: 'grid' as const };
    expect(neighborPane(six, 'e', 'up')).toBe('b');
    expect(neighborPane(six, 'c', 'down')).toBe('f');
    expect(neighborPane({ panes: ['a', 'b'], direction: 'row' }, 'a', 'right')).toBe('b');
    expect(neighborPane({ panes: ['a', 'b'], direction: 'row' }, 'a', 'down')).toBeNull();
    expect(neighborPane({ panes: ['a', 'b'], direction: 'column' }, 'b', 'up')).toBe('a');
    expect(cyclePane({ panes: ['a', 'b', 'c'] }, 'c', 1)).toBe('a');
    expect(nextArrangement('row')).toBe('column');
    expect(arrangementAfterSplit('row', 2, 'row')).toBe('row');
    expect(arrangementAfterSplit('row', 1, 'column')).toBe('column');
  });

  it('zoom shows one pane; it survives a reload, and ends when that pane closes or is the only one', () => {
    let l = addGroup(EMPTY_LAYOUT, 't-a');
    const g = l.groups[0]!.id;
    l = splitGroup(l, g, 't-b', 'row')!;
    l = setArrangement(l, g, 'grid');
    expect(l.groups[0]!.direction).toBe('grid');
    l = toggleZoom(l, g);
    expect(l.groups[0]!.zoomed).toBe('t-b');
    expect(reconcileLayout(parseLayout(JSON.stringify(l)), ['t-a', 't-b']).groups[0]!.zoomed).toBe('t-b');
    expect(toggleZoom(l, g).groups[0]!.zoomed).toBeUndefined();
    const closed = removePane(l, 't-b');
    expect(closed.groups[0]!.zoomed).toBeUndefined();
    expect(toggleZoom(closed, g)).toBe(closed); // a single pane never zooms
  });

  it('focus and mode are per pane; the Agent tab is a valid active tab', () => {
    let l = addGroup(EMPTY_LAYOUT, 't-a');
    l = splitGroup(l, l.groups[0]!.id, 't-b', 'row')!;
    l = focusPane(l, l.groups[0]!.id, 't-a');
    expect(l.groups[0]!.focused).toBe('t-a');
    l = setMode(l, 't-a', 'blocks');
    expect(l.modes['t-a']).toBe('blocks');
    const agent = reconcileLayout({ ...l, active: AGENT_GROUP_ID }, ['t-a', 't-b']);
    expect(agent.active).toBe(AGENT_GROUP_ID);
  });

  it('persists per chat, and survives junk in storage', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };
    const l = addGroup(EMPTY_LAYOUT, 't-a');
    saveLayout('s-1', l, storage);
    expect(loadLayout('s-1', storage)).toEqual(l);
    expect(loadLayout('s-2', storage)).toEqual(EMPTY_LAYOUT);
    store.set(layoutStorageKey('s-3'), '{not json');
    expect(loadLayout('s-3', storage)).toEqual(EMPTY_LAYOUT);
    saveLayout('s-1', EMPTY_LAYOUT, storage);
    expect(store.has(layoutStorageKey('s-1'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------

function key(k: string, mods: Partial<Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>> = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: k, ...mods });
}

describe('panel keys', () => {
  it('macOS: ⌘F find, ⌘D / ⌥⌘D split, ⌘↑/⌘↓ blocks, ⇧⌘K blocks view', () => {
    expect(panelKeyAction(key('f', { metaKey: true }), 'mac')).toBe('find');
    expect(panelKeyAction(key('d', { metaKey: true }), 'mac')).toBe('split-right');
    expect(panelKeyAction(key('∂', { metaKey: true, altKey: true }) as KeyboardEvent, 'mac') ?? panelKeyAction(new KeyboardEvent('keydown', { key: 'd', code: 'KeyD', metaKey: true, altKey: true }), 'mac')).toBe('split-down');
    expect(panelKeyAction(key('ArrowUp', { metaKey: true }), 'mac')).toBe('prev-block');
    expect(panelKeyAction(key('K', { metaKey: true, shiftKey: true }), 'mac')).toBe('toggle-blocks');
    // The shell keeps its own.
    expect(panelKeyAction(key('f', { ctrlKey: true }), 'mac')).toBeNull();
    expect(panelKeyAction(key('c', { ctrlKey: true }), 'mac')).toBeNull();
  });

  it('elsewhere: Ctrl+F / Ctrl+D stay the shell\'s; the panel\'s need Ctrl+Shift', () => {
    expect(panelKeyAction(key('f', { ctrlKey: true }), 'other')).toBeNull();
    expect(panelKeyAction(key('d', { ctrlKey: true }), 'other')).toBeNull();
    expect(panelKeyAction(key('F', { ctrlKey: true, shiftKey: true }), 'other')).toBe('find');
  });

  it('3.15: ⌥⌘arrows move between panes, ⇧⌘↩ zooms, ⌘I describes a command (and ⌘↑ is still the block walk)', () => {
    expect(panelKeyAction(key('ArrowLeft', { metaKey: true, altKey: true }), 'mac')).toBe('focus-left');
    expect(panelKeyAction(key('ArrowDown', { metaKey: true, altKey: true }), 'mac')).toBe('focus-down');
    expect(panelKeyAction(key('ArrowUp', { metaKey: true }), 'mac')).toBe('prev-block');
    expect(panelKeyAction(key('Enter', { metaKey: true, shiftKey: true }), 'mac')).toBe('zoom-pane');
    expect(panelKeyAction(key('i', { metaKey: true }), 'mac')).toBe('assist');
    expect(panelKeyAction(key('ArrowRight', { ctrlKey: true, shiftKey: true, altKey: true }), 'other')).toBe('focus-right');
    expect(panelKeyAction(key('Enter', { ctrlKey: true, shiftKey: true }), 'other')).toBe('zoom-pane');
    // Alt+arrows alone (word motion) stay the shell's.
    expect(panelKeyAction(key('ArrowLeft', { altKey: true }), 'mac')).toBeNull();
    expect(panelKeyAction(key('ArrowLeft', { ctrlKey: true, altKey: true }), 'other')).toBeNull();
  });

  it('app chords with ⌘ pass to the page; ⌃C stays in the shell', () => {
    expect(keyPassesToPage(key('k', { metaKey: true }), 'mac')).toBe(true);
    expect(keyPassesToPage(key('c', { ctrlKey: true }), 'mac')).toBe(false);
    expect(keyPassesToPage(key('k', { ctrlKey: true }), 'other')).toBe(false);
  });
});

describe('stream frames', () => {
  it('reads block, cwd and integration frames besides the 3.10 ones; junk is null', () => {
    const b = block();
    expect(parsePanelSseBlock(`event: block\ndata: ${JSON.stringify({ type: 'block', block: b })}`)).toEqual({ type: 'block', block: b });
    expect(parsePanelSseBlock(`data: ${JSON.stringify({ type: 'cwd', cwd: '~/p' })}`)).toEqual({ type: 'cwd', cwd: '~/p' });
    expect(parsePanelSseBlock(`data: ${JSON.stringify({ type: 'integration', state: 'active' })}`)).toEqual({ type: 'integration', state: 'active' });
    expect(parsePanelSseBlock(`id: 4\nevent: output\ndata: ${JSON.stringify({ type: 'output', seq: 4, dataBase64: 'eA==' })}`)).toEqual({ type: 'output', seq: 4, dataBase64: 'eA==' });
    expect(parsePanelSseBlock(`data: ${JSON.stringify({ type: 'block', block: { id: 'nope' } })}`)).toBeNull();
    expect(parsePanelSseBlock(`data: ${JSON.stringify({ type: 'integration', state: 'weird' })}`)).toBeNull();
    expect(parsePanelSseBlock(': keepalive')).toBeNull();
  });

  it('search colours convert to the #rrggbb the addon wants', () => {
    expect(rgbToHex('rgb(255, 0, 16)')).toBe('#ff0010');
    expect(rgbToHex('rgba(1, 2, 3, 0.5)')).toBe('#010203');
    expect(rgbToHex('red')).toBeNull();
  });
});
