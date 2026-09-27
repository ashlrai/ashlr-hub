/**
 * 3.15 TerminalPanel — RTL over fakes (jsdom has no canvas/WebGL/layout for
 * xterm): the view is a fake behind the PanelView seam, the API and stream
 * are fakes. Under test: reattach (layout + scrollback + blocks after a
 * reload), splits, block markers, the Blocks view and its actions (copy,
 * send to chat through the server's scrub, explain → the chat seat), send
 * selection through /redact, the Agent tab (read-only, nothing re-runs),
 * ⌘D / ⌘F from inside the terminal, and the Node fallback.
 *
 * 3.15 input editor / six panes: the editor at a prompt (and only there), ↩
 * writes text + CR, hand-off when the operator types into the terminal, Raw,
 * ghost text and ↑ from history, ⌃R palette (inserts, never runs; ⌃R again →
 * the shell's), `#` → a generated command to review (risky needs two ↩),
 * ⌘K "Generate command…", six panes in one tab, ⌥⌘arrows, zoom.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  VerseEvent,
  VerseTerminalAssistRequest,
  VerseTerminalBlock,
  VerseTerminalBlockOutputFormat,
  VerseTerminalCreateRequest,
  VerseTerminalListResponse,
  VerseTerminalStreamFrame,
  VerseTerminalTab,
} from '../../../data/api-types.js';
import { resetVerseStore, seedVerseSession } from '../verse-store.js';
import { session } from '../fixtures.test-support.js';
import { layoutStorageKey } from './layout-model.js';
import type { PanelTerminalApi } from './panel-client.js';
import type { PanelStreamHandlers } from './panel-stream.js';
import { resetTerminalPanelForTest, TerminalPanel, type TerminalPanelDeps, type TerminalPanelRequest } from './TerminalPanel.js';
import type { FindOptions, LineMark, LinkHandlers, PanelView, PanelViewOptions } from './xterm-view.js';
import type { InputEditor, InputEditorOptions, InputKeyIntent } from './input-editor.js';
import { resetCommandInputHistoryCache } from './CommandInput.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeMark implements LineMark {
  isDisposed = false;
  constructor(public line: number) {}
  dispose() { this.isDisposed = true; }
}

class FakeView implements PanelView {
  cols = 80;
  rows = 24;
  renderer: 'webgl' | 'dom' = 'webgl';
  host: HTMLElement | null = null;
  written: string[] = [];
  pasted: string[] = [];
  focused = 0;
  selection = '';
  line = 0;
  decorations: Array<{ mark: LineMark; color?: string; el: HTMLElement }> = [];
  finds: Array<[string, FindOptions | undefined]> = [];
  scrolledTo: number[] = [];
  keyFilter: ((e: KeyboardEvent) => boolean) | null = null;
  links: LinkHandlers | null = null;
  opts: PanelViewOptions;
  private dataCbs = new Set<(d: string) => void>();
  private selectionCbs = new Set<() => void>();
  private markCbs = new Set<(p: string) => void>();
  constructor(opts: PanelViewOptions) { this.opts = opts; }
  async open(host: HTMLElement) { this.host = host; }
  write(data: Uint8Array, done?: () => void) {
    const text = new TextDecoder().decode(data);
    this.written.push(text);
    // Parse like xterm: OSC 133 marks in order, lines advance on \n.
    let rest = text;
    for (;;) {
      const i = rest.indexOf('\x1b]133;');
      if (i < 0) break;
      this.line += (rest.slice(0, i).match(/\n/g) ?? []).length;
      const end = rest.indexOf('\x07', i);
      for (const cb of this.markCbs) cb(rest.slice(i + 6, end));
      rest = rest.slice(end + 1);
    }
    this.line += (rest.match(/\n/g) ?? []).length;
    done?.();
  }
  reset() { this.written = []; }
  clear() { this.written = []; }
  focus() { this.focused += 1; }
  fit() { return { cols: this.cols, rows: this.rows }; }
  refresh() {}
  onData(cb: (d: string) => void) { this.dataCbs.add(cb); return { dispose: () => { this.dataCbs.delete(cb); } }; }
  onBinary() { return { dispose: () => {} }; }
  onSelectionChange(cb: () => void) { this.selectionCbs.add(cb); return { dispose: () => { this.selectionCbs.delete(cb); } }; }
  hasSelection() { return this.selection.length > 0; }
  getSelection() { return this.selection; }
  paste(text: string) { this.pasted.push(text); }
  bracketedPaste() { return true; }
  setTheme() {}
  setScreenReaderMode() {}
  setKeyFilter(filter: (e: KeyboardEvent) => boolean) { this.keyFilter = filter; }
  setLigatures() {}
  setLinkHandlers(h: LinkHandlers) { this.links = h; }
  onShellMark(cb: (p: string) => void) { this.markCbs.add(cb); return { dispose: () => { this.markCbs.delete(cb); } }; }
  markCursorLine() { return new FakeMark(this.line); }
  decorate(mark: LineMark, o: { overviewColor?: string; render: (el: HTMLElement) => void }) {
    const el = document.createElement('div');
    o.render(el);
    this.decorations.push({ mark, ...(o.overviewColor ? { color: o.overviewColor } : {}), el });
    return { dispose: () => { el.remove(); } };
  }
  scrollToLine(line: number) { this.scrolledTo.push(line); }
  scrollToBottom() {}
  viewportY() { return 0; }
  selectLines() {}
  async find(term: string, opts?: FindOptions) { this.finds.push([term, opts]); return true; }
  clearFind() {}
  onFindResults() { return { dispose: () => {} }; }
  dispose() {}
  // drivers
  type(data: string) { for (const cb of this.dataCbs) cb(data); }
  select(text: string) { this.selection = text; for (const cb of this.selectionCbs) cb(); }
}

/** The input editor's seam, without CodeMirror: text, ghost, and the intents its keys raise. */
class FakeEditor implements InputEditor {
  text = '';
  ghost: string | null = null;
  placeholder: string;
  focused = 0;
  disposed = false;
  constructor(public opts: InputEditorOptions) {
    this.placeholder = opts.placeholder;
    const el = document.createElement('div');
    el.setAttribute('data-testid', 'fake-editor');
    opts.host.appendChild(el);
  }
  getText() { return this.text; }
  setText(text: string) { this.text = text; this.opts.onChange(text); }
  focus() { this.focused += 1; }
  hasFocus() { return this.focused > 0; }
  setGhost(g: string | null) { this.ghost = g; }
  setPlaceholder(t: string) { this.placeholder = t; }
  dispose() { this.disposed = true; }
  // drivers
  type(text: string) { this.setText(text); }
  press(intent: InputKeyIntent) { return this.opts.onKey(intent); }
}

interface FakeStream { tabId: string; after: () => number; handlers: PanelStreamHandlers; closed: boolean }

function tabOf(id: string, over: Partial<VerseTerminalTab> = {}): VerseTerminalTab {
  return {
    id, sessionId: 's-1', root: '~/code/app', title: 'app', cols: 80, rows: 24,
    createdAt: '2026-09-27T10:00:00.000Z', lastActivityAt: '2026-09-27T10:00:00.000Z',
    exited: null, appId: null, devServerId: null, cwd: '~/code/app/pkg', shellIntegration: 'active', agent: false, ...over,
  };
}

function blockOf(over: Partial<VerseTerminalBlock> = {}): VerseTerminalBlock {
  return {
    id: 'b-1', tabId: 't-1', command: 'npm test', cwd: '~/code/app', startedAt: '2026-09-27T10:00:00.000Z',
    finishedAt: '2026-09-27T10:00:02.000Z', durationMs: 2000, exitCode: 1, state: 'done', startSeq: 1, ordinal: 0,
    outputBytes: 20, truncated: false, evicted: false, fullscreen: false, ...over,
  };
}

function makeStorage() {
  const store = new Map<string, string>();
  return {
    store,
    storage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    },
  };
}

function harness(initial: Partial<VerseTerminalListResponse> = {}) {
  const state: VerseTerminalListResponse = { available: true, reason: null, tabs: [], ...initial };
  let n = 0;
  const views: FakeView[] = [];
  const streams: FakeStream[] = [];
  const inputs: Array<[string, string]> = [];
  const creates: VerseTerminalCreateRequest[] = [];
  const clipboard: string[] = [];
  const outputs: Array<[string, string, VerseTerminalBlockOutputFormat]> = [];
  const editors: FakeEditor[] = [];
  const assists: Array<Record<string, unknown>> = [];
  const history = {
    enabled: true,
    entries: [] as Array<{ cmd: string; ts: string; exit: number | null }>,
  };
  let assistReply = { command: 'du -sh * | sort -h', explanation: 'Sizes of everything here.', provider: 'local:qwen', risky: false };
  const { store, storage } = makeStorage();
  const api: PanelTerminalApi = {
    list: vi.fn(async () => ({ ...state, tabs: [...state.tabs] })),
    create: vi.fn(async (req: VerseTerminalCreateRequest) => {
      creates.push(req);
      const tab = tabOf(`t-new${++n}`, { root: req.root ?? '~/code/app', cwd: null });
      state.tabs.push(tab);
      return tab;
    }),
    input: vi.fn(async (id: string, b64: string) => { inputs.push([id, atob(b64)]); }),
    resize: vi.fn(async () => {}),
    kill: vi.fn(async (id: string) => { state.tabs = state.tabs.filter((t) => t.id !== id); }),
    openExternal: vi.fn(async () => {}),
    blocks: vi.fn(async () => ({ blocks: [] })),
    blockOutput: vi.fn(async (tabId: string, blockId: string, format: VerseTerminalBlockOutputFormat) => {
      outputs.push([tabId, blockId, format]);
      if (format === 'chat') return { block: blockOf(), command: 'npm test', output: 'Error: key [REDACTED] rejected', truncated: false };
      if (format === 'text') return { block: blockOf(), command: 'npm test', output: 'Error: key sk-live rejected', truncated: false };
      return { block: blockOf(), command: 'npm test', output: '\x1b[31mError\x1b[0m: key sk-live rejected', truncated: false };
    }),
    redact: vi.fn(async (text: string) => text.replace(/sk-\w+/g, '[REDACTED]')),
    openFile: vi.fn(async () => {}),
    history: vi.fn(async (query: { q?: string }) => ({
      enabled: history.enabled,
      entries: history.entries.filter((e) => !query.q || e.cmd.includes(query.q)).map((e) => ({
        cmd: e.cmd, cwd: '~/code/app', repo: null, exit: e.exit, durMs: 10, ts: e.ts, count: 1, okCount: e.exit === 0 ? 1 : 0, here: true, sameRepo: false,
      })),
    })),
    clearHistory: vi.fn(async () => { history.entries = []; }),
    settings: vi.fn(async () => ({ history: history.enabled, assist: 'auto' as const })),
    updateSettings: vi.fn(async (patch: { history?: boolean }) => {
      if (patch.history !== undefined) history.enabled = patch.history;
      return { history: history.enabled, assist: 'auto' as const };
    }),
    assist: vi.fn(async (req: VerseTerminalAssistRequest) => { assists.push({ ...req }); return assistReply; }),
    files: vi.fn(async () => [{ root: '~/code/app', path: 'src/config.ts' }]),
  };
  const deps: Partial<TerminalPanelDeps> = {
    api,
    createView: async (opts) => {
      const view = new FakeView(opts);
      views.push(view);
      return view;
    },
    openStream: (tabId, after, handlers) => {
      const stream: FakeStream = { tabId, after, handlers, closed: false };
      streams.push(stream);
      handlers.onState?.('open');
      return { close: () => { stream.closed = true; } };
    },
    platform: 'mac',
    writeClipboard: async (text) => { clipboard.push(text); },
    openUrl: vi.fn(),
    storage,
    createInputEditor: async (opts) => {
      const editor = new FakeEditor(opts);
      editors.push(editor);
      return editor;
    },
    preloadInputEditor: () => {},
  };
  const liveStream = (tabId: string) => streams.filter((s) => s.tabId === tabId && !s.closed).at(-1);
  const emit = (tabId: string, frame: VerseTerminalStreamFrame) => act(() => { liveStream(tabId)!.handlers.onFrame(frame); });
  const output = (tabId: string, seq: number, text: string) => emit(tabId, { type: 'output', seq, dataBase64: btoa(text) });
  const setAssistReply = (reply: typeof assistReply) => { assistReply = reply; };
  return { state, api, deps, views, streams, inputs, creates, clipboard, outputs, store, storage, liveStream, emit, output, editors, assists, history, setAssistReply };
}

type Harness = ReturnType<typeof harness>;

function renderPanel(h: Harness, props: { request?: TerminalPanelRequest | null; onAskChat?: (t: string) => void } = {}) {
  const onSendToChat = vi.fn();
  const utils = render(
    <TerminalPanel
      sessionId="s-1"
      roots={['~/code/app']}
      request={props.request ?? null}
      onSendToChat={onSendToChat}
      {...(props.onAskChat ? { onAskChat: props.onAskChat } : {})}
      visible
      deps={h.deps}
    />,
  );
  return { ...utils, onSendToChat };
}

const PROMPT = '\x1b]133;A\x07% \x1b]133;B\x07';

beforeEach(() => {
  resetTerminalPanelForTest();
  resetVerseStore();
  resetCommandInputHistoryCache();
});

afterEach(() => {
  resetVerseStore();
});

// ---------------------------------------------------------------------------

describe('TerminalPanel', () => {
  it('opens a shell on first sight and streams its output', async () => {
    const h = harness();
    renderPanel(h);
    await waitFor(() => expect(h.api.create).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(h.liveStream('t-new1')).toBeDefined());
    h.output('t-new1', 1, 'hello');
    expect(h.views[0]!.written).toEqual(['hello']);
    // GPU rendering and ligatures are on by default.
    expect(h.views[0]!.opts).toMatchObject({ gpu: true, ligatures: true });
  });

  it('reattach: a reload restores the split layout, resumes each shell after its last seq, and gets its blocks back', async () => {
    const h = harness({ tabs: [tabOf('t-1', { title: 'one' }), tabOf('t-2', { title: 'two' })] });
    h.store.set(layoutStorageKey('s-1'), JSON.stringify({
      groups: [{ id: 'g-1', panes: ['t-1', 't-2'], direction: 'column', focused: 't-2' }],
      active: 'g-1',
      modes: { 't-1': 'blocks' },
    }));
    renderPanel(h);
    await waitFor(() => expect(h.liveStream('t-1')).toBeDefined());
    await waitFor(() => expect(h.liveStream('t-2')).toBeDefined());
    expect(h.api.create).not.toHaveBeenCalled();
    // One tab holding both shells.
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['one +1', 'Agentread-only']);
    const group = document.getElementById('terminal-group-g-1')!;
    expect(group).toHaveAttribute('data-direction', 'column');
    expect(h.liveStream('t-1')!.after()).toBe(0);
    // Replay: output (with the marks), then the block the server kept.
    h.output('t-1', 1, `${PROMPT}npm test\r\n\x1b]133;C\x07FAIL\r\n\x1b]133;D;1\x07`);
    h.emit('t-1', { type: 'block', block: blockOf() });
    expect(h.liveStream('t-1')!.after()).toBe(1);
    // t-1 was in the Blocks view: its card is there.
    const leaf = screen.getByTestId('terminal-leaf-t-1');
    expect(within(leaf).getByText('npm test')).toBeInTheDocument();
    expect(within(leaf).getByText('Exit 1')).toBeInTheDocument();
    // …and the terminal behind it got a red dot on the command's line.
    expect(h.views[0]!.decorations).toHaveLength(1);
    expect(h.views[0]!.decorations[0]!.el.dataset['tone']).toBe('error');
  });

  it('pins a block\'s marker to the prompt line of ITS command — by (seq, ordinal), even with two in one frame', async () => {
    const h = harness({ tabs: [tabOf('t-1')] });
    renderPanel(h);
    await waitFor(() => expect(h.liveStream('t-1')).toBeDefined());
    h.output('t-1', 5, `${PROMPT}a\r\n\x1b]133;C\x07A\r\n\x1b]133;D;0\x07\r\n${PROMPT}b\r\n\x1b]133;C\x07B\r\n\x1b]133;D;2\x07`);
    h.emit('t-1', { type: 'block', block: blockOf({ id: 'b-1', command: 'a', startSeq: 5, ordinal: 0, exitCode: 0 }) });
    h.emit('t-1', { type: 'block', block: blockOf({ id: 'b-2', command: 'b', startSeq: 5, ordinal: 1, exitCode: 2 }) });
    const [first, second] = h.views[0]!.decorations;
    expect(first!.el.dataset['tone']).toBe('ok');
    expect(second!.el.dataset['tone']).toBe('error');
    expect(second!.mark.line).toBeGreaterThan(first!.mark.line);
  });

  it('send to chat: the block goes through the server\'s chat format (secrets scrubbed) into the composer', async () => {
    const user = userEvent.setup();
    const h = harness({ tabs: [tabOf('t-1')] });
    const { onSendToChat } = renderPanel(h);
    await waitFor(() => expect(h.liveStream('t-1')).toBeDefined());
    h.emit('t-1', { type: 'block', block: blockOf() });
    await user.click(screen.getByRole('button', { name: 'Blocks' }));
    await user.click(screen.getByRole('button', { name: 'Send to chat' }));
    await waitFor(() => expect(onSendToChat).toHaveBeenCalledTimes(1));
    expect(h.outputs).toContainEqual(['t-1', 'b-1', 'chat']);
    const text = onSendToChat.mock.calls[0]![0] as string;
    expect(text).toContain('$ npm test');
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain('sk-live');
  });

  it('explain / fix: a failed block is SENT to the chat seat when the host allows it', async () => {
    const user = userEvent.setup();
    const onAskChat = vi.fn();
    const h = harness({ tabs: [tabOf('t-1')] });
    const { onSendToChat } = renderPanel(h, { onAskChat });
    await waitFor(() => expect(h.liveStream('t-1')).toBeDefined());
    h.emit('t-1', { type: 'block', block: blockOf() });
    await user.click(screen.getByRole('button', { name: 'Blocks' }));
    await user.click(screen.getByRole('button', { name: 'Explain and fix this error' }));
    await waitFor(() => expect(onAskChat).toHaveBeenCalledTimes(1));
    expect(onAskChat.mock.calls[0]![0]).toMatch(/Explain what went wrong and how to fix it/);
    expect(onSendToChat).not.toHaveBeenCalled();
  });

  it('copy output copies plain text; a card unfolds its output in colour', async () => {
    const user = userEvent.setup();
    const h = harness({ tabs: [tabOf('t-1')] });
    renderPanel(h);
    await waitFor(() => expect(h.liveStream('t-1')).toBeDefined());
    h.emit('t-1', { type: 'block', block: blockOf() });
    await user.click(screen.getByRole('button', { name: 'Blocks' }));
    // The latest (and failed) block is open, and loads its output as ANSI.
    const out = await screen.findByLabelText('Output of npm test');
    expect(out.textContent).toBe('Error: key sk-live rejected');
    expect(out.querySelector('span[style]')).toHaveStyle({ color: 'var(--term-red)' });
    await user.click(screen.getByRole('button', { name: 'Copy output' }));
    await waitFor(() => expect(h.clipboard).toContain('Error: key sk-live rejected'));
    expect(h.outputs).toContainEqual(['t-1', 'b-1', 'text']);
  });

  it('send selection goes through /redact and arrives fenced', async () => {
    const user = userEvent.setup();
    const h = harness({ tabs: [tabOf('t-1')] });
    const { onSendToChat } = renderPanel(h);
    await waitFor(() => expect(h.views).toHaveLength(1));
    act(() => h.views[0]!.select('token sk-abc123 here'));
    await user.click(screen.getByRole('button', { name: 'Send selection to chat' }));
    await waitFor(() => expect(onSendToChat).toHaveBeenCalledWith('```\ntoken [REDACTED] here\n```'));
    expect(h.api.redact).toHaveBeenCalledWith('token sk-abc123 here');
  });

  it('⌘D inside the terminal splits beside it, in the shell\'s current directory; ⌘F opens find', async () => {
    const h = harness({ tabs: [tabOf('t-1')] });
    renderPanel(h);
    await waitFor(() => expect(h.views[0]?.keyFilter).toBeTruthy());
    const cmdD = new KeyboardEvent('keydown', { key: 'd', metaKey: true, cancelable: true });
    let passed = true;
    act(() => { passed = h.views[0]!.keyFilter!(cmdD); });
    expect(passed).toBe(false);
    expect(cmdD.defaultPrevented).toBe(true);
    await waitFor(() => expect(h.api.create).toHaveBeenCalledTimes(1));
    expect(h.creates[0]).toMatchObject({ root: '~/code/app', cwd: '~/code/app/pkg' });
    await waitFor(() => expect(screen.getByTestId('terminal-leaf-t-new1')).toBeInTheDocument());
    expect(document.querySelector('[data-split]')).not.toBeNull();

    const cmdF = new KeyboardEvent('keydown', { key: 'f', metaKey: true, cancelable: true });
    act(() => { h.views[0]!.keyFilter!(cmdF); });
    const find = await screen.findByRole('searchbox', { name: 'Find' }).catch(() => screen.getByLabelText('Find'));
    fireEvent.change(find, { target: { value: 'error' } });
    await waitFor(() => expect(h.views[0]!.finds.at(-1)).toEqual(['error', { caseSensitive: false, regex: false }]));
    // ⌃C still belongs to the shell.
    expect(h.views[0]!.keyFilter!(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true }))).toBe(true);
  });

  it('⌘-click on file:line opens it through the server (which decides if it may)', async () => {
    const h = harness({ tabs: [tabOf('t-1')] });
    renderPanel(h);
    await waitFor(() => expect(h.views[0]?.links).toBeTruthy());
    // No command above it: the shell's current directory.
    h.views[0]!.links!.openFile({ path: 'src/a.ts', line: 3, column: 7, start: 0, end: 10 }, 0);
    await waitFor(() => expect(h.api.openFile).toHaveBeenCalledWith('t-1', { path: 'src/a.ts', line: 3, column: 7, cwd: '~/code/app/pkg' }));
    // Printed by a command that ran elsewhere: relative to where THAT command ran.
    await waitFor(() => expect(h.liveStream('t-1')).toBeDefined());
    h.output('t-1', 1, `${PROMPT}tsc\r\n\x1b]133;C\x07src/b.ts:9 error\r\n\x1b]133;D;2\x07`);
    h.emit('t-1', { type: 'block', block: blockOf({ command: 'tsc', cwd: '~/code/app/web', exitCode: 2 }) });
    h.views[0]!.links!.openFile({ path: 'src/b.ts', line: 9, column: null, start: 0, end: 10 }, 1);
    await waitFor(() => expect(h.api.openFile).toHaveBeenLastCalledWith('t-1', { path: 'src/b.ts', line: 9, cwd: '~/code/app/web' }));
  });

  it('the Agent tab shows the chat\'s agent commands read-only — and never runs one', async () => {
    const user = userEvent.setup();
    const events: VerseEvent[] = [
      { seq: 1, at: '2026-09-27T10:00:00.000Z', type: 'turn-start', turnId: 'turn-1' } as unknown as VerseEvent,
      { seq: 2, at: '2026-09-27T10:00:01.000Z', type: 'tool-use', turnId: 'turn-1', toolUseId: 'tu-1', name: 'Bash', input: { command: 'rm -rf build && npm run build' } },
      { seq: 3, at: '2026-09-27T10:00:04.000Z', type: 'tool-result', turnId: 'turn-1', toolUseId: 'tu-1', output: 'error TS2322\nexit code 2', isError: true },
    ];
    seedVerseSession('s-1', session({ id: 's-1' }), events);
    const h = harness({ tabs: [tabOf('t-1')] });
    const { onSendToChat } = renderPanel(h, { request: { nonce: 1, agent: true } });
    const agent = await screen.findByTestId('agent-terminal');
    expect(within(agent).getByText('rm -rf build && npm run build')).toBeInTheDocument();
    // The exit code the output stated in so many words (never invented).
    expect(within(agent).getByText('Exit 2')).toBeInTheDocument();
    await user.click(within(agent).getByRole('button', { name: 'Copy command' }));
    expect(h.clipboard).toContain('rm -rf build && npm run build');
    await user.click(within(agent).getByRole('button', { name: 'Send to chat' }));
    expect(onSendToChat.mock.calls[0]![0]).toContain('An agent ran this command');
    // "Paste" types it at a prompt of YOUR terminal and stops: no Enter, no input request.
    await user.click(within(agent).getByRole('button', { name: 'Paste command in terminal' }));
    await waitFor(() => expect(h.liveStream('t-1')).toBeDefined());
    h.output('t-1', 1, '% ');
    await waitFor(() => expect(h.views[0]!.pasted).toEqual(['rm -rf build && npm run build']));
    expect(h.inputs).toEqual([]);
  });

  it('without a PTY (Node): says the terminal needs the desktop app — the Agent tab still works', async () => {
    const h = harness({ available: false, reason: 'needs the desktop app' });
    renderPanel(h);
    expect(await screen.findByText('Agent')).toBeInTheDocument();
    expect(screen.getByTestId('agent-terminal')).toBeInTheDocument();
    expect(h.api.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3.15 — the input editor
// ---------------------------------------------------------------------------

const RUN = '\x1b]133;C\x07';

async function atPrompt(h: Harness, tabId = 't-1', seq = 1) {
  await waitFor(() => expect(h.liveStream(tabId)).toBeDefined());
  h.output(tabId, seq, PROMPT);
  await waitFor(() => expect(h.editors.length).toBeGreaterThan(0));
  const input = screen.getByTestId(`command-input-${tabId}`);
  await waitFor(() => expect(input).not.toHaveAttribute('hidden'));
  return { editor: h.editors.at(-1)!, input };
}

describe('TerminalPanel — the input editor', () => {
  it('shows at a prompt (after B), takes the keyboard, runs ↩ as text + CR, and hides while the command runs', async () => {
    const h = harness({ tabs: [tabOf('t-1')] });
    renderPanel(h);
    await waitFor(() => expect(h.liveStream('t-1')).toBeDefined());
    // Before any prompt: no editor.
    h.output('t-1', 1, 'Last login: today\r\n');
    expect(screen.queryByTestId('fake-editor')).toBeNull();
    const { editor, input } = await atPrompt(h, 't-1', 2);
    await waitFor(() => expect(editor.focused).toBeGreaterThan(0));
    act(() => editor.type('ls -la'));
    act(() => { editor.press('submit'); });
    await waitFor(() => expect(h.inputs).toEqual([['t-1', 'ls -la\r']]));
    expect(editor.text).toBe('');
    h.output('t-1', 3, `ls -la\r\n${RUN}total 0\r\n`);
    await waitFor(() => expect(input).toHaveAttribute('hidden'));
    // The next prompt brings it back (the same editor, kept between prompts).
    h.output('t-1', 4, `\x1b]133;D;0\x07${PROMPT}`);
    await waitFor(() => expect(input).not.toHaveAttribute('hidden'));
    expect(h.editors).toHaveLength(1);
  });

  it('several lines go as ONE bracketed paste; ⌃C clears, then interrupts; ⌃D and ⌃L are the shell\'s', async () => {
    const h = harness({ tabs: [tabOf('t-1')] });
    renderPanel(h);
    const { editor } = await atPrompt(h);
    act(() => editor.type('for f in *; do\n  echo $f\ndone'));
    act(() => { editor.press('submit'); });
    await waitFor(() => expect(h.inputs.at(-1)).toEqual(['t-1', '\x1b[200~for f in *; do\n  echo $f\ndone\x1b[201~\r']));
    act(() => editor.type('half typed'));
    act(() => { editor.press('interrupt'); });
    expect(editor.text).toBe('');
    act(() => { editor.press('interrupt'); });
    act(() => { editor.press('eof'); });
    act(() => { editor.press('clear-screen'); });
    // Single-flight input may coalesce them: what matters is the bytes, in order.
    await waitFor(() => expect(h.inputs.map(([, d]) => d).join('').endsWith('\x03\x04\x0c')).toBe(true));
  });

  it('typing into the terminal itself hands the prompt to the shell until the next one; terminal replies do not', async () => {
    const h = harness({ tabs: [tabOf('t-1')] });
    renderPanel(h);
    const { input } = await atPrompt(h);
    act(() => h.views[0]!.type('\x1b[12;1R'));
    expect(input).not.toHaveAttribute('hidden');
    act(() => h.views[0]!.type('l'));
    await waitFor(() => expect(input).toHaveAttribute('hidden'));
    await waitFor(() => expect(h.inputs.map(([, d]) => d)).toContain('l'));
    h.output('t-1', 2, `s\r\n${RUN}x\r\n\x1b]133;D;0\x07${PROMPT}`);
    await waitFor(() => expect(input).not.toHaveAttribute('hidden'));
  });

  it('Esc and ⇥ give the line to the shell\'s own editor (vi mode, fzf-tab) and the terminal the keyboard', async () => {
    const h = harness({ tabs: [tabOf('t-1')] });
    renderPanel(h);
    const { editor, input } = await atPrompt(h);
    const before = h.views[0]!.focused;
    act(() => editor.type('git ch'));
    act(() => { editor.press('tab'); });
    await waitFor(() => expect(h.inputs.at(-1)).toEqual(['t-1', 'git ch\t']));
    await waitFor(() => expect(input).toHaveAttribute('hidden'));
    expect(h.views[0]!.focused).toBeGreaterThan(before);
  });

  it('Raw input for a shell (⋯ menu) turns the editor off for it — and it stays off after a reload', async () => {
    const user = userEvent.setup();
    const h = harness({ tabs: [tabOf('t-1')] });
    const first = renderPanel(h);
    const { input } = await atPrompt(h);
    await user.click(screen.getByRole('button', { name: 'More terminal options' }));
    await user.click(screen.getByRole('menuitem', { name: /^Raw input for this shell/ }));
    await waitFor(() => expect(screen.queryByTestId('command-input-t-1')).toBeNull());
    expect(input.isConnected).toBe(false);
    first.unmount();
    renderPanel(h);
    await waitFor(() => expect(h.liveStream('t-1')).toBeDefined());
    h.output('t-1', 1, PROMPT);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('command-input-t-1')).toBeNull();
  });

  it('ghost text and ↑ come from the persistent history', async () => {
    const h = harness({ tabs: [tabOf('t-1')] });
    h.history.entries = [
      { cmd: 'git status', ts: '2026-09-27T09:00:00.000Z', exit: 0 },
      { cmd: 'npm test', ts: '2026-09-27T09:30:00.000Z', exit: 1 },
    ];
    renderPanel(h);
    const { editor } = await atPrompt(h);
    await waitFor(() => expect(h.api.history).toHaveBeenCalledWith({ cwd: '~/code/app/pkg', limit: 300 }));
    act(() => editor.type('git s'));
    expect(editor.ghost).toBe('git status');
    act(() => editor.type(''));
    act(() => { editor.press('history-prev'); });
    // ↑ is most recent first.
    expect(editor.text).toBe('npm test');
    act(() => { editor.press('history-prev'); });
    expect(editor.text).toBe('git status');
    act(() => { editor.press('history-next'); });
    expect(editor.text).toBe('npm test');
  });

  it('⌃R: the history palette inserts the command (never runs it); ⌃R again hands the search to the shell', async () => {
    const user = userEvent.setup();
    const h = harness({ tabs: [tabOf('t-1')] });
    h.history.entries = [{ cmd: 'docker compose up -d', ts: '2026-09-27T09:00:00.000Z', exit: 0 }];
    renderPanel(h);
    const { editor } = await atPrompt(h);
    act(() => editor.type('docker'));
    act(() => { editor.press('history-search'); });
    const dialog = await screen.findByRole('dialog', { name: 'Command history' });
    const option = await within(dialog).findByRole('option', { name: /docker compose up -d/ });
    expect(option).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(editor.text).toBe('docker compose up -d'));
    expect(h.inputs).toEqual([]);

    act(() => { editor.press('history-search'); });
    const again = await screen.findByRole('dialog', { name: 'Command history' });
    const box = within(again).getByRole('combobox');
    fireEvent.keyDown(box, { key: 'r', ctrlKey: true });
    await waitFor(() => expect(h.inputs.at(-1)).toEqual(['t-1', '\x12docker compose up -d']));
    expect(screen.queryByRole('dialog', { name: 'Command history' })).toBeNull();
  });

  it('# plain words → the local model → a command to REVIEW; a risky one needs a second ↩', async () => {
    const h = harness({ tabs: [tabOf('t-1')] });
    renderPanel(h);
    const { editor } = await atPrompt(h);
    act(() => editor.type('# how big is everything here'));
    act(() => { editor.press('submit'); });
    await waitFor(() => expect(editor.text).toBe('du -sh * | sort -h'));
    expect(h.assists[0]).toEqual({ request: 'how big is everything here', tabId: 't-1', cwd: '~/code/app/pkg' });
    expect(h.inputs).toEqual([]);
    expect(await screen.findByText(/Sizes of everything here\. · Review, then Return to run · from local:qwen/)).toBeInTheDocument();
    act(() => { editor.press('submit'); });
    await waitFor(() => expect(h.inputs).toEqual([['t-1', 'du -sh * | sort -h\r']]));

    h.setAssistReply({ command: 'rm -rf build', explanation: 'Deletes build.', provider: 'local:qwen', risky: true });
    act(() => editor.type('clean the build'));
    act(() => { editor.press('assist'); });
    await waitFor(() => expect(editor.text).toBe('rm -rf build'));
    act(() => { editor.press('submit'); });
    expect(await screen.findByText(/changes or deletes things\. Press Return again/)).toBeInTheDocument();
    expect(h.inputs).toHaveLength(1);
    act(() => { editor.press('submit'); });
    await waitFor(() => expect(h.inputs.at(-1)).toEqual(['t-1', 'rm -rf build\r']));
  });

  it('⌘K "Generate command…" opens the editor\'s # mode at a prompt; with no editor, a palette whose command is pasted, not run', async () => {
    const user = userEvent.setup();
    const h = harness({ tabs: [tabOf('t-1')] });
    const view = renderPanel(h, { request: { nonce: 1 } });
    const { editor } = await atPrompt(h);
    view.rerender(
      <TerminalPanel sessionId="s-1" roots={['~/code/app']} request={{ nonce: 2, assist: true }} onSendToChat={vi.fn()} visible deps={h.deps} />,
    );
    await waitFor(() => expect(editor.text).toBe('# '));

    // A shell without integration: no editor, so the palette asks instead.
    const h2 = harness({ tabs: [tabOf('t-9', { shellIntegration: 'off' })] });
    resetTerminalPanelForTest();
    view.unmount();
    renderPanel(h2, { request: { nonce: 3, assist: true } });
    const dialog = await screen.findByRole('dialog', { name: 'Generate a command' });
    await user.type(within(dialog).getByRole('combobox'), 'list open ports');
    await user.keyboard('{Enter}');
    await within(dialog).findByRole('option', { name: /du -sh/ });
    await user.keyboard('{Enter}');
    await waitFor(() => expect(h2.views[0]!.pasted).toEqual(['du -sh * | sort -h']));
    expect(h2.inputs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3.15 — six panes
// ---------------------------------------------------------------------------

describe('TerminalPanel — six panes in a tab', () => {
  it('⌘D up to six shells in one tab (one stream subscription each, all on the shared connection), ⌥⌘← moves focus, ⇧⌘↩ zooms', async () => {
    const h = harness({ tabs: [tabOf('t-1')] });
    renderPanel(h);
    await waitFor(() => expect(h.views[0]?.keyFilter).toBeTruthy());
    for (let i = 0; i < 5; i++) {
      act(() => { h.views[0]!.keyFilter!(new KeyboardEvent('keydown', { key: 'd', metaKey: true, cancelable: true })); });
      await waitFor(() => expect(h.api.create).toHaveBeenCalledTimes(i + 1));
      await waitFor(() => expect(screen.getByTestId(`terminal-leaf-t-new${i + 1}`)).toBeInTheDocument());
    }
    const group = document.querySelector('[data-split]')!;
    expect(group.querySelectorAll('[data-testid^="terminal-leaf-"]')).toHaveLength(6);
    await waitFor(() => expect(new Set(h.streams.filter((s) => !s.closed).map((s) => s.tabId)).size).toBe(6));
    // A seventh is refused with a reason.
    act(() => { h.views[0]!.keyFilter!(new KeyboardEvent('keydown', { key: 'd', metaKey: true, cancelable: true })); });
    expect(await screen.findByText('A tab holds 6 terminals at most. Open a new tab instead.')).toBeInTheDocument();
    expect(h.api.create).toHaveBeenCalledTimes(5);

    // Focus is on the newest pane; ⌥⌘← moves it one to the left.
    const leaf = (id: string) => screen.getByTestId(`terminal-leaf-${id}`);
    await waitFor(() => expect(leaf('t-new5')).toHaveAttribute('data-focused'));
    const newest = h.views.at(-1)!;
    act(() => { newest.keyFilter!(new KeyboardEvent('keydown', { key: 'ArrowLeft', metaKey: true, altKey: true, cancelable: true })); });
    await waitFor(() => expect(leaf('t-new4')).toHaveAttribute('data-focused'));

    // ⇧⌘↩ in the focused pane: it alone; again: all of them.
    const focusedView = h.views[4]!; // t-new4's
    act(() => { focusedView.keyFilter!(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, shiftKey: true, cancelable: true })); });
    await waitFor(() => expect(leaf('t-1')).toHaveAttribute('hidden'));
    expect(leaf('t-new4')).not.toHaveAttribute('hidden');
    expect(leaf('t-new5')).toHaveAttribute('hidden');
    act(() => { focusedView.keyFilter!(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, shiftKey: true, cancelable: true })); });
    await waitFor(() => expect(leaf('t-1')).not.toHaveAttribute('hidden'));
  });

  it('the panel\'s keys work from the input editor too (⌘D splits, ⇧⌘↩ zooms); ⌘I stays the editor\'s', async () => {
    const h = harness({ tabs: [tabOf('t-1')] });
    renderPanel(h);
    const { editor } = await atPrompt(h);
    const box = screen.getByTestId('fake-editor');
    fireEvent.keyDown(box, { key: 'd', code: 'KeyD', metaKey: true });
    await waitFor(() => expect(h.api.create).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('terminal-leaf-t-new1')).toBeInTheDocument());
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true, shiftKey: true });
    await waitFor(() => expect(screen.getByTestId('terminal-leaf-t-new1')).toHaveAttribute('hidden'));
    // ⌘I is not taken by the panel here: the editor's own keymap turns it into "describe it".
    const cmdI = new KeyboardEvent('keydown', { key: 'i', metaKey: true, bubbles: true, cancelable: true });
    box.dispatchEvent(cmdI);
    expect(cmdI.defaultPrevented).toBe(false);
    expect(editor.text).toBe('');
  });

  it('a split tab can be tiled from the ⋯ menu, and the grid survives a reload', async () => {
    const user = userEvent.setup();
    const h = harness({ tabs: [tabOf('t-1'), tabOf('t-2'), tabOf('t-3')] });
    h.store.set(layoutStorageKey('s-1'), JSON.stringify({
      groups: [{ id: 'g-1', panes: ['t-1', 't-2', 't-3'], direction: 'row', focused: 't-1' }], active: 'g-1', modes: {},
    }));
    const first = renderPanel(h);
    await waitFor(() => expect(document.getElementById('terminal-group-g-1')).toHaveAttribute('data-direction', 'row'));
    await user.click(screen.getByRole('button', { name: 'More terminal options' }));
    await user.click(screen.getByRole('menuitem', { name: 'Grid' }));
    const group = document.getElementById('terminal-group-g-1')!;
    await waitFor(() => expect(group).toHaveAttribute('data-direction', 'grid'));
    expect(group).toHaveAttribute('data-cols', '2');
    // The third pane spans the last row.
    expect(screen.getByTestId('terminal-leaf-t-3')).toHaveAttribute('data-span', '2');
    first.unmount();
    renderPanel(h);
    await waitFor(() => expect(document.getElementById('terminal-group-g-1')).toHaveAttribute('data-direction', 'grid'));
  });
});
