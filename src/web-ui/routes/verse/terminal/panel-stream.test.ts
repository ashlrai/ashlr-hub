/**
 * 3.15 — the terminal stream multiplexer (panel-stream.ts): every visible pane
 * on ONE fetch() of `/api/verse/terminal/stream?tabs=id:seq,…`.
 *
 *   - subscriptions made in one commit become ONE connection;
 *   - each tab resumes past its own seq on every (re)connect;
 *   - frames are demuxed by tab; `gone` ends only that tab;
 *   - a subscription change reconnects with the new set; the last close disconnects;
 *   - a drop reconnects; a 401 renews once; an older server (404) falls back
 *     to one per-tab stream per pane.
 */
import { describe, expect, it, vi } from 'vitest';
import type { VerseTerminalStreamFrame } from '../../../data/api-types.js';
import { createTerminalStreamMux, muxStreamPath, parseMuxSseBlock, type PanelStreamOpener } from './panel-stream.js';
import type { TerminalStreamState } from './panel-stream.js';

interface Conn {
  url: string;
  headers: Record<string, string>;
  push(text: string): void;
  end(): void;
  aborted: boolean;
}

function fakeServer(status = 200) {
  const conns: Conn[] = [];
  const enc = new TextEncoder();
  const fetchFake = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    let closed = false;
    const body = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; } });
    const conn: Conn = {
      url: String(url),
      headers: init?.headers as Record<string, string>,
      aborted: false,
      push(text) { if (!closed) ctrl.enqueue(enc.encode(text)); },
      end() { if (!closed) { closed = true; ctrl.close(); } },
    };
    init?.signal?.addEventListener('abort', () => {
      conn.aborted = true;
      if (!closed) { closed = true; ctrl.error(new DOMException('aborted', 'AbortError')); }
    });
    conns.push(conn);
    return new Response(status === 200 ? body : null, { status });
  });
  return { conns, fetch: fetchFake as unknown as typeof fetch, live: () => conns.filter((c) => !c.aborted) };
}

const frame = (tab: string, f: Record<string, unknown>) => `event: ${String(f['type'])}\ndata: ${JSON.stringify({ tab, ...f })}\n\n`;
const out = (tab: string, seq: number, text: string) => frame(tab, { type: 'output', seq, dataBase64: btoa(text) });
const decodeTabs = (url: string) => decodeURIComponent(new URL(url, 'http://x').searchParams.get('tabs') ?? '');

function pane(mux: ReturnType<typeof createTerminalStreamMux>, id: string, start = 0) {
  const frames: VerseTerminalStreamFrame[] = [];
  const states: TerminalStreamState[] = [];
  let seq = start;
  const handle = mux.subscribe(id, () => seq, {
    onFrame: (f) => { frames.push(f); if (f.type === 'output') seq = f.seq; },
    onState: (s) => states.push(s),
  });
  return { frames, states, handle, text: () => frames.filter((f) => f.type === 'output').map((f) => atob((f as { dataBase64: string }).dataBase64)).join('') };
}

describe('mux frames', () => {
  it('parses tagged frames and `gone`; rejects untagged or junk', () => {
    expect(parseMuxSseBlock(out('t-a', 3, 'x').trim())).toEqual({ tab: 't-a', frame: { type: 'output', seq: 3, dataBase64: btoa('x') } });
    expect(parseMuxSseBlock(frame('t-a', { type: 'cwd', cwd: '~/p' }).trim())).toEqual({ tab: 't-a', frame: { type: 'cwd', cwd: '~/p' } });
    expect(parseMuxSseBlock('event: gone\ndata: {"tab":"t-b","type":"gone"}')).toEqual({ tab: 't-b', frame: { type: 'gone' } });
    expect(parseMuxSseBlock('data: {"type":"output","seq":1,"dataBase64":""}')).toBeNull();
    expect(parseMuxSseBlock('data: {"tab":"../x","type":"gone"}')).toBeNull();
    expect(parseMuxSseBlock(': keepalive')).toBeNull();
    expect(muxStreamPath([['t-a', 5], ['t-b', 0]])).toBe(`/api/verse/terminal/stream?tabs=${encodeURIComponent('t-a:5,t-b')}`);
  });
});

describe('createTerminalStreamMux', () => {
  it('many panes subscribed in one commit share ONE connection, each resumed past its own seq, frames demuxed', async () => {
    const server = fakeServer();
    const mux = createTerminalStreamMux({ fetch: server.fetch, proof: () => 'p'.repeat(64), backoffMs: () => 0 });
    const panes = ['t-a', 't-b', 't-c', 't-d', 't-e', 't-f'].map((id, i) => pane(mux, id, i));
    await vi.waitFor(() => expect(server.conns).toHaveLength(1));
    expect(decodeTabs(server.conns[0]!.url)).toBe('t-a,t-b:1,t-c:2,t-d:3,t-e:4,t-f:5');
    expect(server.conns[0]!.headers['x-ashlr-read-client']).toBe('p'.repeat(64));
    const whole = out('t-b', 2, 'bee') + out('t-f', 6, 'eff') + frame('t-a', { type: 'title', title: 'zsh' });
    server.conns[0]!.push(whole.slice(0, 17));
    server.conns[0]!.push(whole.slice(17));
    await vi.waitFor(() => expect(panes[5]!.text()).toBe('eff'));
    expect(panes[1]!.text()).toBe('bee');
    expect(panes[0]!.frames).toEqual([{ type: 'title', title: 'zsh' }]);
    expect(panes[2]!.frames).toEqual([]);
    expect(panes.every((p) => p.states.at(-1) === 'open')).toBe(true);
    mux.close();
    expect(server.conns[0]!.aborted).toBe(true);
  });

  it('a new pane reconnects with the new set (resuming the others); gone ends one tab; the last close disconnects', async () => {
    const server = fakeServer();
    const mux = createTerminalStreamMux({ fetch: server.fetch, backoffMs: () => 0 });
    const a = pane(mux, 't-a');
    await vi.waitFor(() => expect(server.conns).toHaveLength(1));
    server.conns[0]!.push(out('t-a', 1, 'one'));
    await vi.waitFor(() => expect(a.text()).toBe('one'));
    const b = pane(mux, 't-b');
    await vi.waitFor(() => expect(server.conns).toHaveLength(2));
    expect(server.conns[0]!.aborted).toBe(true);
    expect(decodeTabs(server.conns[1]!.url)).toBe('t-a:1,t-b');
    server.conns[1]!.push(out('t-a', 2, 'two') + frame('t-b', { type: 'gone' }));
    await vi.waitFor(() => expect(b.states.at(-1)).toBe('gone'));
    expect(a.text()).toBe('onetwo');
    expect(mux.tabs()).toEqual(['t-a']);
    a.handle.close();
    await vi.waitFor(() => expect(server.conns[1]!.aborted).toBe(true));
    expect(a.states.at(-1)).toBe('closed');
    expect(server.conns).toHaveLength(2);
  });

  it('a close and a subscribe in the same commit (a group switch) are ONE reconnect', async () => {
    const server = fakeServer();
    const mux = createTerminalStreamMux({ fetch: server.fetch, backoffMs: () => 0 });
    const a = pane(mux, 't-a');
    await vi.waitFor(() => expect(server.conns).toHaveLength(1));
    a.handle.close();
    pane(mux, 't-b');
    pane(mux, 't-c');
    await vi.waitFor(() => expect(server.conns).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 10));
    expect(server.conns).toHaveLength(2);
    expect(decodeTabs(server.conns[1]!.url)).toBe('t-b,t-c');
  });

  it('a dropped connection reconnects, resuming every tab where it was', async () => {
    const server = fakeServer();
    const mux = createTerminalStreamMux({ fetch: server.fetch, backoffMs: () => 0 });
    const a = pane(mux, 't-a');
    await vi.waitFor(() => expect(server.conns).toHaveLength(1));
    server.conns[0]!.push(out('t-a', 7, 'x'));
    await vi.waitFor(() => expect(a.text()).toBe('x'));
    server.conns[0]!.end();
    await vi.waitFor(() => expect(server.conns).toHaveLength(2));
    expect(a.states).toContain('reconnecting');
    expect(decodeTabs(server.conns[1]!.url)).toBe('t-a:7');
    mux.close();
  });

  it('an older server (404) falls back to one per-tab stream per pane', async () => {
    const server = fakeServer(404);
    const opened: string[] = [];
    const openSingle: PanelStreamOpener = (tabId, _after, handlers) => {
      opened.push(tabId);
      handlers.onState?.('open');
      return { close: () => { opened.push(`closed:${tabId}`); } };
    };
    const mux = createTerminalStreamMux({ fetch: server.fetch, backoffMs: () => 0, openSingle });
    pane(mux, 't-a');
    const b = pane(mux, 't-b');
    await vi.waitFor(() => expect(opened).toEqual(['t-a', 't-b']));
    pane(mux, 't-c');
    expect(opened).toEqual(['t-a', 't-b', 't-c']);
    b.handle.close();
    expect(opened.at(-1)).toBe('closed:t-b');
    expect(server.conns).toHaveLength(1);
  });

  it('a 401 renews the read session once; a second is "expired" for every pane', async () => {
    const server = fakeServer(401);
    const renew = vi.fn(async () => true);
    const mux = createTerminalStreamMux({ fetch: server.fetch, renew, backoffMs: () => 0 });
    const a = pane(mux, 't-a');
    const b = pane(mux, 't-b');
    await vi.waitFor(() => expect(b.states.at(-1)).toBe('expired'));
    expect(a.states.at(-1)).toBe('expired');
    expect(renew).toHaveBeenCalledTimes(1);
    expect(server.conns).toHaveLength(2);
  });
});
