/**
 * TerminalPane (unit C4) — RTL + user-event on the keyboard paths, the 375
 * layout, and the dark palette (SPEC-310C §7 test method).
 *
 * xterm needs a real layout engine, so the view is a fake behind the
 * TerminalView seam; the API and the stream are fakes too. What is under test
 * is the pane's behaviour: auto-open, streaming into the right view, ordered
 * input, tabs by keyboard, "Run in terminal" pasting WITHOUT running, send
 * selection, exit / restart / close, the Node fallback, and the key filter
 * that lets the app's own chords through.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerseTerminalCreateRequest, VerseTerminalFrame, VerseTerminalListResponse, VerseTerminalTab } from '../../../../data/api-types.js';
import { ApiError } from '../../../../data/client.js';
import type { TerminalOpenRequest } from '../../shell/slots.js';
import { mockCompactViewport, mockWideViewport, type ViewportMock } from '../../shell/viewport.test-support.js';
import { createInputQueue } from './input-queue.js';
import { fenceSelection, type TerminalApi } from './terminal-client.js';
import type { TerminalStreamHandlers } from './terminal-stream.js';
import type { TerminalTheme, TerminalView, TerminalViewOptions } from './terminal-view.js';
import type { TerminalRequest } from '../dock-store.js';
import { keyPassesToPage, resetTerminalPaneForTest, TerminalPane, type TerminalPaneDeps } from './TerminalPane.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeView implements TerminalView {
  cols = 80;
  rows = 24;
  host: HTMLElement | null = null;
  written: string[] = [];
  pasted: string[] = [];
  resets = 0;
  focused = 0;
  selection = '';
  bracketed = true;
  screenReader: boolean;
  theme: TerminalTheme;
  keyFilter: ((e: KeyboardEvent) => boolean) | null = null;
  disposed = false;
  private dataCbs = new Set<(d: string) => void>();
  private selectionCbs = new Set<() => void>();
  constructor(opts: TerminalViewOptions) {
    this.screenReader = opts.screenReaderMode;
    this.theme = opts.theme;
  }
  open(host: HTMLElement) { this.host = host; }
  write(data: Uint8Array) { this.written.push(new TextDecoder().decode(data)); }
  reset() { this.resets += 1; this.written = []; }
  focus() { this.focused += 1; }
  fit() { return { cols: this.cols, rows: this.rows }; }
  onData(cb: (d: string) => void) { this.dataCbs.add(cb); return { dispose: () => this.dataCbs.delete(cb) }; }
  onBinary() { return { dispose: () => {} }; }
  onSelectionChange(cb: () => void) { this.selectionCbs.add(cb); return { dispose: () => this.selectionCbs.delete(cb) }; }
  hasSelection() { return this.selection.length > 0; }
  getSelection() { return this.selection; }
  paste(text: string) { this.pasted.push(text); }
  bracketedPaste() { return this.bracketed; }
  setTheme(theme: TerminalTheme) { this.theme = theme; }
  setScreenReaderMode(on: boolean) { this.screenReader = on; }
  setKeyFilter(filter: (e: KeyboardEvent) => boolean) { this.keyFilter = filter; }
  dispose() { this.disposed = true; }
  // test drivers
  type(data: string) { for (const cb of this.dataCbs) cb(data); }
  select(text: string) { this.selection = text; for (const cb of this.selectionCbs) cb(); }
}

interface FakeStream { tabId: string; after: () => number; handlers: TerminalStreamHandlers; closed: boolean }

function tabOf(id: string, over: Partial<VerseTerminalTab> = {}): VerseTerminalTab {
  return {
    id,
    sessionId: 's-1',
    root: '~/code/app',
    title: 'app',
    cols: 80,
    rows: 24,
    createdAt: '2026-09-24T10:00:00.000Z',
    lastActivityAt: '2026-09-24T10:00:00.000Z',
    exited: null,
    appId: null,
    devServerId: null,
    ...over,
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
  const api: TerminalApi = {
    list: vi.fn(async () => ({ ...state, tabs: [...state.tabs] })),
    create: vi.fn(async (req: VerseTerminalCreateRequest) => {
      creates.push(req);
      const tab = tabOf(`t-new${++n}`, { root: req.root ?? '~/code/app', appId: req.appId ?? null, devServerId: req.devServerId ?? null });
      state.tabs.push(tab);
      return tab;
    }),
    input: vi.fn(async (id: string, b64: string) => { inputs.push([id, atob(b64)]); }),
    resize: vi.fn(async () => {}),
    kill: vi.fn(async (id: string) => { state.tabs = state.tabs.filter((t) => t.id !== id); }),
    openExternal: vi.fn(async () => {}),
  };
  const deps: Partial<TerminalPaneDeps> = {
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
  };
  const liveStream = (tabId: string) => streams.filter((s) => s.tabId === tabId && !s.closed).at(-1);
  const emit = (tabId: string, frame: VerseTerminalFrame) => act(() => { liveStream(tabId)!.handlers.onFrame(frame); });
  const output = (tabId: string, seq: number, text: string) => emit(tabId, { type: 'output', seq, dataBase64: btoa(text) });
  return { state, api, deps, views, streams, inputs, creates, clipboard, liveStream, emit, output };
}

type Harness = ReturnType<typeof harness>;

function renderPane(h: Harness, props: { request?: TerminalOpenRequest | null; visible?: boolean; roots?: string[]; onSendToChat?: (t: string) => void } = {}) {
  const onSendToChat = props.onSendToChat ?? vi.fn();
  const utils = render(
    <TerminalPane
      sessionId="s-1"
      roots={props.roots ?? ['~/code/app']}
      request={props.request ?? null}
      onSendToChat={onSendToChat}
      visible={props.visible ?? true}
      deps={h.deps}
    />,
  );
  return { ...utils, onSendToChat };
}

let viewport: ViewportMock | null = null;

beforeEach(() => {
  resetTerminalPaneForTest();
  try { localStorage.clear(); } catch { /* jsdom always has it */ }
});

afterEach(() => {
  viewport?.restore();
  viewport = null;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TerminalPane', () => {
  it('opens a login shell in the chat\'s folder on first sight, and streams its output into the view', async () => {
    const h = harness();
    renderPane(h);
    await waitFor(() => expect(h.api.create).toHaveBeenCalledTimes(1));
    expect(h.creates[0]).toMatchObject({ sessionId: 's-1', cols: 80, rows: 24 });
    const tab = await screen.findByRole('tab', { name: /app/ });
    expect(tab).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(h.liveStream('t-new1')).toBeDefined());
    expect(h.views[0]!.host).toBeInTheDocument();
    h.output('t-new1', 1, 'hello\r\n% ');
    expect(h.views[0]!.written).toEqual(['hello\r\n% ']);
    // The header shows where the shell runs.
    expect(screen.getByText('~/code/app')).toBeInTheDocument();
  });

  it('reattaches to existing tabs after a reload instead of opening another, resuming after the last seq', async () => {
    const h = harness({ tabs: [tabOf('t-1')] });
    renderPane(h);
    await waitFor(() => expect(h.liveStream('t-1')).toBeDefined());
    expect(h.api.create).not.toHaveBeenCalled();
    expect(h.liveStream('t-1')!.after()).toBe(0);
    h.output('t-1', 1, 'a');
    h.output('t-1', 2, 'b');
    h.output('t-1', 2, 'b'); // a replayed duplicate is dropped
    expect(h.views[0]!.written).toEqual(['a', 'b']);
    expect(h.liveStream('t-1')!.after()).toBe(2);
    // A gap (frames the ring dropped) starts the view over rather than drawing a torn screen.
    h.output('t-1', 9, 'fresh');
    expect(h.views[0]!.resets).toBe(1);
    expect(h.views[0]!.written).toEqual(['fresh']);
  });

  it('sends keystrokes in order, one request at a time', async () => {
    const h = harness({ tabs: [tabOf('t-1')] });
    let release: () => void = () => {};
    (h.api.input as ReturnType<typeof vi.fn>).mockImplementationOnce(async (id: string, b64: string) => {
      h.inputs.push([id, atob(b64)]);
      await new Promise<void>((r) => { release = r; });
    });
    renderPane(h);
    await waitFor(() => expect(h.views).toHaveLength(1));
    act(() => { h.views[0]!.type('l'); h.views[0]!.type('s'); h.views[0]!.type('\r'); });
    expect(h.inputs).toEqual([['t-1', 'l']]);
    await act(async () => { release(); await Promise.resolve(); });
    await waitFor(() => expect(h.inputs).toEqual([['t-1', 'l'], ['t-1', 's\r']]));
  });

  it('moves between tabs with ← → Home End, and streams only the visible one', async () => {
    const user = userEvent.setup();
    const h = harness({ tabs: [tabOf('t-1', { title: 'one' }), tabOf('t-2', { title: 'two' }), tabOf('t-3', { title: 'three' })] });
    renderPane(h);
    const three = await screen.findByRole('tab', { name: /three/ });
    await waitFor(() => expect(three).toHaveAttribute('aria-selected', 'true'));
    three.focus();
    await user.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: /one/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /one/ })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: /two/ })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(screen.getByRole('tab', { name: /three/ })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(h.liveStream('t-3')).toBeDefined());
    expect(h.streams.filter((s) => !s.closed).map((s) => s.tabId)).toEqual(['t-3']);
    // Only the selected tab's panel is shown.
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
  });

  it('marks unseen output in a background tab', async () => {
    const h = harness({ tabs: [tabOf('t-1', { title: 'bg', lastActivityAt: '2026-09-24T10:05:00.000Z' }), tabOf('t-2', { title: 'fg' })] });
    renderPane(h);
    const bg = await screen.findByRole('tab', { name: /bg/ });
    expect(within(bg).getByRole('img', { name: 'new output' })).toBeInTheDocument();
  });

  it('"Run in terminal" pastes the command at the prompt and never presses Enter', async () => {
    const h = harness({ tabs: [tabOf('t-1')] });
    const { rerender } = renderPane(h);
    await waitFor(() => expect(h.liveStream('t-1')).toBeDefined());
    h.output('t-1', 1, '% ');
    rerender(
      <TerminalPane sessionId="s-1" roots={['~/code/app']} request={{ nonce: 7, paste: 'npm test -- --watch\n' }}
        onSendToChat={vi.fn()} visible deps={h.deps} />,
    );
    await waitFor(() => expect(h.views[0]!.pasted).toEqual(['npm test -- --watch']));
    expect(h.inputs.some(([, text]) => text.includes('\r'))).toBe(false);
    expect(h.api.create).not.toHaveBeenCalled();
  });

  it('copies a multi-line command instead of pasting it when the shell has no bracketed paste', async () => {
    const h = harness({ tabs: [tabOf('t-1')] });
    const { rerender } = renderPane(h);
    await waitFor(() => expect(h.liveStream('t-1')).toBeDefined());
    h.views[0]!.bracketed = false;
    h.output('t-1', 1, '$ ');
    rerender(
      <TerminalPane sessionId="s-1" roots={['~/code/app']} request={{ nonce: 3, paste: 'cd app\nrm -rf build' }}
        onSendToChat={vi.fn()} visible deps={h.deps} />,
    );
    expect(await screen.findByText(/copied instead/)).toBeInTheDocument();
    expect(h.views[0]!.pasted).toEqual([]);
    expect(h.clipboard).toEqual(['cd app\nrm -rf build']);
  });

  it('a new-tab, Launch or dev-server request opens a new tab with that request', async () => {
    const h = harness({ tabs: [tabOf('t-1')] });
    const { rerender } = renderPane(h);
    await waitFor(() => expect(h.liveStream('t-1')).toBeDefined());
    rerender(<TerminalPane sessionId="s-1" roots={['~/code/app']} request={{ nonce: 1, devServerId: 'dev-abc', root: '~/code/app' }} onSendToChat={vi.fn()} visible deps={h.deps} />);
    await waitFor(() => expect(h.creates).toHaveLength(1));
    expect(h.creates[0]).toMatchObject({ devServerId: 'dev-abc', root: '~/code/app' });
    rerender(<TerminalPane sessionId="s-1" roots={['~/code/app']} request={{ nonce: 2, appId: 'codex' }} onSendToChat={vi.fn()} visible deps={h.deps} />);
    await waitFor(() => expect(h.creates).toHaveLength(2));
    expect(h.creates[1]).toMatchObject({ appId: 'codex' });
    // The same request again (a re-render, a remount) is not handled twice.
    rerender(<TerminalPane sessionId="s-1" roots={['~/code/app']} request={{ nonce: 2, appId: 'codex' }} onSendToChat={vi.fn()} visible deps={h.deps} />);
    expect(h.creates).toHaveLength(2);
    // An Apps launch through Ollama carries via/model to the server, which
    // resolves the command itself (TerminalRequest ⊇ TerminalOpenRequest).
    const launch: TerminalRequest = { nonce: 3, newTab: true, appId: 'codex', via: 'ollama', model: 'qwen3.8:27b' };
    rerender(<TerminalPane sessionId="s-1" roots={['~/code/app']} request={launch} onSendToChat={vi.fn()} visible deps={h.deps} />);
    await waitFor(() => expect(h.creates).toHaveLength(3));
    expect(h.creates[2]).toMatchObject({ appId: 'codex', via: 'ollama', model: 'qwen3.8:27b' });
  });

  it('sends the selection to the chat as a fenced block that cannot be closed early', async () => {
    const user = userEvent.setup();
    const h = harness({ tabs: [tabOf('t-1')] });
    const { onSendToChat } = renderPane(h);
    await waitFor(() => expect(h.views).toHaveLength(1));
    const send = screen.getByRole('button', { name: 'Send selection to chat' });
    expect(send).toBeDisabled();
    act(() => h.views[0]!.select('error: ```boom```'));
    expect(send).toBeEnabled();
    await user.click(send);
    expect(onSendToChat).toHaveBeenCalledWith('````\nerror: ```boom```\n````');
    // Copy on select.
    await waitFor(() => expect(h.clipboard).toContain('error: ```boom```'));
  });

  it('shows an exited shell with Restart and Close', async () => {
    const user = userEvent.setup();
    const h = harness({ tabs: [tabOf('t-1')] });
    renderPane(h);
    await waitFor(() => expect(h.liveStream('t-1')).toBeDefined());
    h.emit('t-1', { type: 'exit', code: 2, signal: null });
    expect(await screen.findByText('Shell exited with code 2.')).toBeInTheDocument();
    expect(within(screen.getByRole('tab', { name: /app/ })).getByText('exited')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Restart' }));
    await waitFor(() => expect(h.api.kill).toHaveBeenCalledWith('t-1'));
    expect(h.creates[0]).toMatchObject({ root: '~/code/app' });
  });

  it('closes a tab from its × and lands on a neighbour; the empty pane offers a new terminal', async () => {
    const user = userEvent.setup();
    const h = harness({ tabs: [tabOf('t-1', { title: 'one' })] });
    renderPane(h);
    await user.click(await screen.findByRole('button', { name: 'Close terminal one' }));
    expect(h.api.kill).toHaveBeenCalledWith('t-1');
    expect(await screen.findByText('No terminal open')).toBeInTheDocument();
    expect(h.views[0]!.disposed).toBe(true);
    await user.click(screen.getByRole('button', { name: 'New terminal' }));
    await waitFor(() => expect(h.creates).toHaveLength(1));
  });

  it('says why a new tab was refused (the 8-tab cap)', async () => {
    const user = userEvent.setup();
    const h = harness({ tabs: [tabOf('t-1')] });
    (h.api.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ApiError('POST failed', 409, '/api/verse/terminal', '8 terminals are already open. Close one to open another.', 'TERMINAL_LIMIT'),
    );
    renderPane(h);
    await user.click(await screen.findByRole('button', { name: 'New terminal tab' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('8 terminals are already open. Close one to open another.');
  });

  it('under Node, says the terminal needs the desktop app and still opens Terminal.app', async () => {
    const user = userEvent.setup();
    const h = harness({ available: false, reason: 'The terminal needs the Ashlr desktop app.' });
    renderPane(h);
    expect(await screen.findByText('Terminal needs the desktop app')).toBeInTheDocument();
    expect(h.api.create).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Open in Terminal' }));
    expect(h.api.openExternal).toHaveBeenCalledWith('s-1', '~/code/app');
  });

  it('does nothing while hidden: no shell, no stream', async () => {
    const h = harness({ tabs: [] });
    renderPane(h, { visible: false });
    await waitFor(() => expect(h.api.list).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    expect(h.api.create).not.toHaveBeenCalled();
    expect(h.streams).toHaveLength(0);
  });

  it('toggles screen-reader mode and remembers it', async () => {
    const user = userEvent.setup();
    const h = harness({ tabs: [tabOf('t-1')] });
    renderPane(h);
    await waitFor(() => expect(h.views).toHaveLength(1));
    const toggle = screen.getByRole('button', { name: 'Screen reader mode' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(h.views[0]!.screenReader).toBe(true);
    expect(localStorage.getItem('ashlr.verse.terminal.screenReader')).toBe('1');
  });

  it('with several roots, the chevron offers a new tab in any of them (keyboard menu)', async () => {
    const user = userEvent.setup();
    const h = harness({ tabs: [tabOf('t-1')] });
    renderPane(h, { roots: ['~/code/app', '~/code/lib'] });
    await user.click(await screen.findByRole('button', { name: 'New terminal in…' }));
    const menu = await screen.findByRole('menu', { name: 'New terminal in' });
    await user.click(within(menu).getByRole('menuitem', { name: /lib/ }));
    await waitFor(() => expect(h.creates[0]).toMatchObject({ root: '~/code/lib' }));
  });

  it('at 375 the header keeps every action reachable by name (icons only)', async () => {
    viewport = mockCompactViewport();
    const h = harness({ tabs: [tabOf('t-1')] });
    renderPane(h);
    await waitFor(() => expect(h.views).toHaveLength(1));
    const send = screen.getByRole('button', { name: 'Send selection to chat' });
    expect(send).not.toHaveTextContent('Send to chat');
    expect(screen.getByRole('button', { name: 'Open in Terminal.app' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Screen reader mode' })).toBeInTheDocument();
  });

  it('at 1440 the send action is labelled', async () => {
    viewport = mockWideViewport();
    const h = harness({ tabs: [tabOf('t-1')] });
    renderPane(h);
    await waitFor(() => expect(h.views).toHaveLength(1));
    expect(screen.getByRole('button', { name: 'Send selection to chat' })).toHaveTextContent('Send to chat');
  });
});

describe('key filter — the app\'s chords pass through the terminal, the shell\'s stay', () => {
  const key = (init: KeyboardEventInit & { key: string; code?: string }) => new KeyboardEvent('keydown', init);
  it('on macOS', () => {
    expect(keyPassesToPage(key({ key: 'k', metaKey: true }), 'mac')).toBe(true); // palette
    expect(keyPassesToPage(key({ key: 'j', metaKey: true }), 'mac')).toBe(true); // needs you
    expect(keyPassesToPage(key({ key: '`', code: 'Backquote', ctrlKey: true }), 'mac')).toBe(true); // dock terminal
    expect(keyPassesToPage(key({ key: 'c', ctrlKey: true }), 'mac')).toBe(false); // SIGINT
    expect(keyPassesToPage(key({ key: 'r', ctrlKey: true }), 'mac')).toBe(false); // history search
    expect(keyPassesToPage(key({ key: 'Escape' }), 'mac')).toBe(false);
    expect(keyPassesToPage(key({ key: 'c', metaKey: true }), 'mac')).toBe(false); // copy is not a command: default action
    expect(keyPassesToPage(new KeyboardEvent('keyup', { key: 'k', metaKey: true }), 'mac')).toBe(false);
  });
  it('elsewhere, Ctrl+K stays with the shell', () => {
    expect(keyPassesToPage(key({ key: 'k', ctrlKey: true }), 'other')).toBe(false);
    expect(keyPassesToPage(key({ key: '`', code: 'Backquote', ctrlKey: true }), 'other')).toBe(true);
  });
});

describe('helpers', () => {
  it('fences a selection one backtick longer than anything inside it', () => {
    expect(fenceSelection('ls -la\n')).toBe('```\nls -la\n```');
    expect(fenceSelection('a ```` b')).toBe('`````\na ```` b\n`````');
  });

  it('input queue: splits a long paste into 16 KB requests, in order', async () => {
    const sent: string[] = [];
    const q = createInputQueue(async (b64) => { sent.push(atob(b64)); }, { maxBytes: 4 });
    q.pushText('abcdefghij');
    await q.idle();
    expect(sent).toEqual(['abcd', 'efgh', 'ij']);
  });

  it('input queue: a failed request is reported and not replayed after newer input', async () => {
    const sent: string[] = [];
    const errors: unknown[] = [];
    let fail = true;
    const q = createInputQueue(async (b64) => {
      if (fail) { fail = false; throw new Error('offline'); }
      sent.push(atob(b64));
    }, { onError: (e) => errors.push(e) });
    q.pushText('x');
    await q.idle();
    q.pushText('y');
    await q.idle();
    expect(sent).toEqual(['y']);
    expect(errors).toHaveLength(1);
  });
});
