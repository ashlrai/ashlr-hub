/**
 * 3.15 TerminalPanel — the terminal for MANY AGENTS (RTL over the same fakes
 * as TerminalPanel.test.tsx): agent tab badges, "Ask…" any seat / all seats,
 * error-fix chips (paste, never run), multi-select, filter-in-block,
 * bookmarks, verse://terminal links and requests, re-run, "Open in Browser
 * pane" for a local URL, the sticky running header, launch configurations.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  VerseSeat,
  VerseTerminalBlock,
  VerseTerminalBlockOutputFormat,
  VerseTerminalCreateRequest,
  VerseTerminalListResponse,
  VerseTerminalStreamFrame,
  VerseTerminalTab,
} from '../../../data/api-types.js';
import { resetVerseStore } from '../verse-store.js';
import { CLAUDE_SEAT, CODEX_SEAT, session } from '../fixtures.test-support.js';
import type { PanelTerminalApi } from './panel-client.js';
import type { PanelStreamHandlers } from './panel-stream.js';
import { resetTerminalPanelForTest, TerminalPanel, type TerminalPanelDeps, type TerminalPanelRequest } from './TerminalPanel.js';
import type { FindOptions, LineMark, LinkHandlers, PanelView, PanelViewOptions } from './xterm-view.js';

const askSeatMock = vi.hoisted(() => vi.fn());
const requestPreviewMock = vi.hoisted(() => vi.fn());

vi.mock('../multimodel/ask-seat.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../multimodel/ask-seat.js')>()),
  askSeat: askSeatMock,
}));
vi.mock('../dock/dock-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../dock/dock-store.js')>()),
  requestPreview: requestPreviewMock,
}));


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
    fix: vi.fn(async () => ({ suggestions: [{ command: 'npm install', why: 'A dependency is missing.' }], model: 'qwen-test' })),
    launchList: vi.fn(async () => ({
      configs: [{ name: 'Dev', root: '~/code/app', tabs: [{ split: 'down' as const, panes: [{ cwd: 'web', command: 'npm run dev', agent: null }, { cwd: null, command: 'npm test -- --watch', agent: null }] }] }],
      errors: [],
    })),
    launch: vi.fn(async () => {
      const a = tabOf(`t-l${++n}`, { title: 'dev' });
      const b = tabOf(`t-l${++n}`, { title: 'test' });
      state.tabs.push(a, b);
      return { groups: [{ split: 'down' as const, tabs: [a, b] }], errors: [] };
    }),
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
  };
  const liveStream = (tabId: string) => streams.filter((s) => s.tabId === tabId && !s.closed).at(-1);
  const emit = (tabId: string, frame: VerseTerminalStreamFrame) => act(() => { liveStream(tabId)!.handlers.onFrame(frame); });
  const output = (tabId: string, seq: number, text: string) => emit(tabId, { type: 'output', seq, dataBase64: btoa(text) });
  return { state, api, deps, views, streams, inputs, creates, clipboard, outputs, store, storage, liveStream, emit, output };
}

type Harness = ReturnType<typeof harness>;

const CODEX_READY: VerseSeat = { ...CODEX_SEAT, health: { state: 'ready', summary: null, windows: [], observedAt: null } };
const DEVIN_SEAT: VerseSeat = { ...CODEX_READY, id: 'devin-cli', engine: 'devin', label: 'Devin (CLI)', accountId: 'devin', models: [{ id: 'devin', label: 'Devin', contextWindow: 200_000 }] };
const SEATS: VerseSeat[] = [CLAUDE_SEAT, CODEX_READY, DEVIN_SEAT];
const CHAT = session({ id: 's-1', seatId: CLAUDE_SEAT.id, title: 'Fix the build' });

function renderPanel(h: Harness, props: { request?: TerminalPanelRequest | null; seats?: VerseSeat[]; onOpenSession?: (id: string) => void } = {}) {
  const onSendToChat = vi.fn();
  const utils = render(
    <TerminalPanel
      sessionId="s-1"
      roots={['~/code/app']}
      request={props.request ?? null}
      onSendToChat={onSendToChat}
      visible
      session={CHAT}
      seats={props.seats ?? SEATS}
      {...(props.onOpenSession ? { onOpenSession: props.onOpenSession } : {})}
      deps={h.deps}
    />,
  );
  return { ...utils, onSendToChat };
}

const PROMPT = '\x1b]133;A\x07% \x1b]133;B\x07';

beforeEach(() => {
  resetTerminalPanelForTest();
  resetVerseStore();
  askSeatMock.mockReset();
  askSeatMock.mockImplementation(async (_api: unknown, input: { target: { seatId: string; label: string } }) => ({
    sessionId: input.target.seatId === CLAUDE_SEAT.id ? 's-1' : 'new-chat', created: input.target.seatId !== CLAUDE_SEAT.id, label: input.target.label,
  }));
  requestPreviewMock.mockReset();
});

afterEach(() => {
  resetVerseStore();
});

async function openBlocks(h: Harness, blocks: VerseTerminalBlock[], user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() => expect(h.liveStream('t-1')).toBeDefined());
  for (const block of blocks) h.emit('t-1', { type: 'block', block });
  await user.click(screen.getByRole('button', { name: 'Blocks' }));
}

describe('TerminalPanel — many agents', () => {
  it('agent tabs carry a live status badge: from the list, then from the stream', async () => {
    const h = harness({ tabs: [tabOf('t-1', { title: 'claude', agent: true, appId: 'claude-code', agentState: { agent: 'claude-code', state: 'needs-you', since: '2026-09-27T10:00:00.000Z', source: 'hook', channel: 'hooks', message: 'Claude needs your permission to use Bash' } })] });
    renderPanel(h);
    const badge = await screen.findByText('needs you');
    expect(badge).toHaveAttribute('data-state', 'needs-you');
    expect(badge.getAttribute('title')).toContain('Claude needs your permission to use Bash');
    await waitFor(() => expect(h.liveStream('t-1')).toBeDefined());
    h.emit('t-1', { type: 'agent-state', agentState: { agent: 'claude-code', state: 'running', since: '2026-09-27T10:01:00.000Z', source: 'hook', channel: 'hooks', message: null } });
    expect(await screen.findByText('working')).toHaveAttribute('data-state', 'running');
    h.emit('t-1', { type: 'agent-state', agentState: null });
    await waitFor(() => expect(screen.queryByText('working')).toBeNull());
    expect(screen.getByText('agent')).toBeInTheDocument();
  });

  it('Ask… lists every seat; picking one sends the SCRUBBED block to that seat\'s chat, with a way to open it', async () => {
    const user = userEvent.setup();
    const onOpenSession = vi.fn();
    const h = harness({ tabs: [tabOf('t-1')] });
    renderPanel(h, { onOpenSession });
    await openBlocks(h, [blockOf()], user);
    await user.click(screen.getByRole('button', { name: 'Ask a seat about this command' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      expect.stringContaining('Ask Claude Max'),
      expect.stringContaining('Ask Personal Codex'),
      expect.stringContaining('Ask Devin (CLI)'),
      expect.stringContaining('Ask all ready seats (3)'),
    ]);
    await user.click(within(menu).getByRole('menuitem', { name: /Ask Personal Codex/ }));
    await waitFor(() => expect(askSeatMock).toHaveBeenCalledTimes(1));
    const input = askSeatMock.mock.calls[0]![1] as { source: { id: string }; target: { seatId: string }; text: string };
    expect(input.source.id).toBe('s-1');
    expect(input.target.seatId).toBe('codex-personal');
    expect(input.text).toContain('[REDACTED]');
    expect(input.text).not.toContain('sk-live');
    expect(h.outputs).toContainEqual(['t-1', 'b-1', 'chat']);
    await user.click(await screen.findByRole('button', { name: 'Open chat' }));
    expect(onOpenSession).toHaveBeenCalledWith('new-chat');
  });

  it('"Ask all ready seats" opens Compare with every ready seat chosen — nothing sent until confirmed', async () => {
    const user = userEvent.setup();
    const h = harness({ tabs: [tabOf('t-1')] });
    renderPanel(h);
    await openBlocks(h, [blockOf()], user);
    await user.click(screen.getByRole('button', { name: 'Ask a seat about this command' }));
    await user.click(await screen.findByRole('menuitem', { name: /Ask all ready seats/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Send to 3 seats' })).toBeEnabled();
    expect(within(dialog).getAllByRole('checkbox').filter((c) => (c as HTMLInputElement).checked)).toHaveLength(3);
    expect(askSeatMock).not.toHaveBeenCalled();
  });

  it('a failed command gets the local model\'s fix chips: [Paste] types it and stops; Ask <seat> asks', async () => {
    const user = userEvent.setup();
    const h = harness({ tabs: [tabOf('t-1')] });
    renderPanel(h);
    await waitFor(() => expect(h.liveStream('t-1')).toBeDefined());
    h.output('t-1', 1, `${PROMPT}npm test\r\n\x1b]133;C\x07FAIL\r\n\x1b]133;D;1\x07`);
    h.emit('t-1', { type: 'block', block: blockOf() });
    // In the terminal view: a bar under the terminal.
    const bar = await screen.findByRole('group', { name: 'Fix this error' });
    await waitFor(() => expect(h.api.fix).toHaveBeenCalledWith('t-1', 'b-1'));
    await user.click(await within(bar).findByRole('button', { name: 'Paste npm install' }));
    await waitFor(() => expect(h.views[0]!.pasted).toEqual(['npm install']));
    expect(h.inputs).toEqual([]);
    // One seat per family that fixes code.
    expect(within(bar).getAllByRole('button').map((b) => b.textContent)).toEqual(expect.arrayContaining(['Ask Claude Max', 'Ask Personal Codex', 'Ask Devin (CLI)']));
    await user.click(within(bar).getByRole('button', { name: 'Ask Devin (CLI)' }));
    await waitFor(() => expect(askSeatMock).toHaveBeenCalledTimes(1));
    expect((askSeatMock.mock.calls[0]![1] as { target: { seatId: string } }).target.seatId).toBe('devin-cli');
    await user.click(within(bar).getByRole('button', { name: 'Dismiss fix suggestions' }));
    expect(screen.queryByRole('group', { name: 'Fix this error' })).toBeNull();
  });

  it('fix chips can be turned off (More), and then the local model is not asked', async () => {
    const user = userEvent.setup();
    const h = harness({ tabs: [tabOf('t-1')] });
    renderPanel(h);
    await waitFor(() => expect(h.liveStream('t-1')).toBeDefined());
    await user.click(screen.getByRole('button', { name: 'More terminal options' }));
    await user.click(await screen.findByRole('menuitem', { name: /Stop suggesting fixes/ }));
    expect(h.store.get('ashlr.verse.terminal.fixChips.v1')).toBe('0');
    h.emit('t-1', { type: 'block', block: blockOf() });
    await screen.findByRole('group', { name: 'Fix this error' });
    expect(h.api.fix).not.toHaveBeenCalled();
  });

  it('⇧/⌘-click selects several blocks; the selection is sent (scrubbed) as ONE message', async () => {
    const user = userEvent.setup();
    const h = harness({ tabs: [tabOf('t-1')] });
    const { onSendToChat } = renderPanel(h);
    await openBlocks(h, [blockOf({ id: 'b-1', command: 'npm ci', exitCode: 0 }), blockOf({ id: 'b-2', command: 'npm test', exitCode: 1 })], user);
    const heads = screen.getAllByTitle(/select several/);
    await user.keyboard('{Meta>}');
    await user.click(heads[0]!);
    await user.click(heads[1]!);
    await user.keyboard('{/Meta}');
    expect(await screen.findByText('2 selected')).toBeInTheDocument();
    await user.click(within(screen.getByRole('toolbar', { name: 'Selected blocks' })).getByRole('button', { name: 'Send to chat' }));
    await waitFor(() => expect(onSendToChat).toHaveBeenCalledTimes(1));
    const text = onSendToChat.mock.calls[0]![0] as string;
    expect(text).toMatch(/^I ran these 2 commands in my terminal:/);
    expect(text).not.toContain('sk-live');
  });

  it('filter-in-block keeps (or, inverted, drops) matching lines', async () => {
    const user = userEvent.setup();
    const h = harness({ tabs: [tabOf('t-1')] });
    (h.api.blockOutput as ReturnType<typeof vi.fn>).mockImplementation(async (_t: string, _b: string, format: VerseTerminalBlockOutputFormat) => ({
      block: blockOf(), command: 'npm test', output: format === 'ansi' ? 'ok 1\nFAIL a\nok 2' : '', truncated: false,
    }));
    renderPanel(h);
    await openBlocks(h, [blockOf()], user);
    const out = await screen.findByLabelText('Output of npm test');
    expect(out.textContent).toBe('ok 1\nFAIL a\nok 2');
    await user.click(screen.getByRole('button', { name: 'Filter output lines' }));
    await user.type(screen.getByRole('textbox', { name: 'Filter lines' }), 'ok');
    expect(screen.getByLabelText('Output of npm test').textContent).toBe('ok 1\nok 2');
    expect(screen.getByText('2 of 3 lines')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Invert: hide matching lines' }));
    expect(screen.getByLabelText('Output of npm test').textContent).toBe('FAIL a');
  });

  it('bookmarks, copy link, and a verse://terminal request that opens the block', async () => {
    const user = userEvent.setup();
    const h = harness({ tabs: [tabOf('t-1')] });
    const { rerender, onSendToChat } = renderPanel(h);
    await openBlocks(h, [blockOf({ id: 'b-1', exitCode: 0 }), blockOf({ id: 'b-2', command: 'make', exitCode: 0 })], user);
    await user.click(screen.getAllByRole('button', { name: 'Bookmark this block' })[0]!);
    expect(screen.getByRole('button', { name: 'Remove bookmark' })).toHaveAttribute('aria-pressed', 'true');
    expect(JSON.parse(h.store.get('ashlr.verse.terminal.bookmarks.v1')!)).toEqual({ 't-1': ['b-1'] });
    await user.click(screen.getByTitle('Show only bookmarked blocks'));
    expect(screen.queryByTestId('block-b-2')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Copy link to this block' }));
    await waitFor(() => expect(h.clipboard).toContain('verse://terminal/t-1/b-1'));

    // Back to the terminal, then a link to b-2 arrives: Blocks view, b-2 ringed.
    await user.click(screen.getByRole('button', { name: 'Terminal' }));
    rerender(
      <TerminalPanel sessionId="s-1" roots={['~/code/app']} request={{ nonce: 5, tabId: 't-1', blockId: 'b-2' }}
        onSendToChat={onSendToChat} visible session={CHAT} seats={SEATS} deps={h.deps} />,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Blocks' })).toHaveAttribute('aria-pressed', 'true'));
    await waitFor(() => expect(screen.getByTestId('block-b-2')).toHaveAttribute('data-highlight', 'true'));
    rerender(
      <TerminalPanel sessionId="s-1" roots={['~/code/app']} request={{ nonce: 6, tabId: 't-gone' }}
        onSendToChat={onSendToChat} visible session={CHAT} seats={SEATS} deps={h.deps} />,
    );
    expect(await screen.findByText('That terminal is no longer open.')).toBeInTheDocument();
  });

  it('re-run types the command and Enter into its own tab; a local URL opens in the Browser pane', async () => {
    const user = userEvent.setup();
    const h = harness({ tabs: [tabOf('t-1')] });
    renderPanel(h);
    await openBlocks(h, [blockOf({ id: 'b-1', command: 'npm run dev', exitCode: 0, localUrls: ['http://localhost:5173/'] })], user);
    await user.click(screen.getByRole('button', { name: 'Re-run this command' }));
    await waitFor(() => expect(h.inputs).toEqual([['t-1', 'npm run dev\r']]));
    // Re-run switched back to the terminal: the URL bar is there too.
    const bar = await screen.findByRole('group', { name: 'A local server is up' });
    await user.click(within(bar).getByRole('button', { name: /localhost:5173/ }));
    expect(requestPreviewMock).toHaveBeenCalledWith({ url: 'http://localhost:5173/' });
  });

  it('a running command gets a sticky header once its prompt has scrolled away', async () => {
    const h = harness({ tabs: [tabOf('t-1')] });
    renderPanel(h);
    await waitFor(() => expect(h.liveStream('t-1')).toBeDefined());
    h.output('t-1', 1, `${PROMPT}npm run build\r\n\x1b]133;C\x07building\r\n`);
    h.views[0]!.viewportY = () => 50;
    h.emit('t-1', { type: 'block', block: blockOf({ command: 'npm run build', state: 'running', exitCode: null, finishedAt: null, durationMs: null, startedAt: new Date(Date.now() - 75_000).toISOString() }) });
    const sticky = await screen.findByRole('status', { name: 'Running: npm run build' });
    expect(sticky.textContent).toMatch(/1m 1\ds/);
  });

  it('the palette\'s "Launch terminal configuration…" arrives as a request and opens the dialog (typing nothing)', async () => {
    const h = harness({ tabs: [tabOf('t-1')] });
    renderPanel(h, { request: { nonce: 9, launch: true } });
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('npm test -- --watch')).toBeInTheDocument();
    expect(h.api.launch).not.toHaveBeenCalled();
    expect(h.inputs).toEqual([]);
  });

  it('launch configurations: listed with their commands, launched by name into a split tab', async () => {
    const user = userEvent.setup();
    const h = harness({ tabs: [tabOf('t-1')] });
    renderPanel(h);
    await waitFor(() => expect(h.liveStream('t-1')).toBeDefined());
    await user.click(screen.getByRole('button', { name: 'More terminal options' }));
    await user.click(await screen.findByRole('menuitem', { name: /Launch configuration/ }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('npm run dev')).toBeInTheDocument();
    expect(h.api.launch).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Launch Dev' }));
    await waitFor(() => expect(h.api.launch).toHaveBeenCalledWith({ sessionId: 's-1', root: '~/code/app', name: 'Dev', cols: 80, rows: 24 }));
    await waitFor(() => expect(screen.getAllByRole('tab').map((t) => t.textContent)).toContain('dev +1'));
    const group = screen.getByTestId('terminal-leaf-t-l2').parentElement!;
    expect(group).toHaveAttribute('data-direction', 'column');
  });
});
