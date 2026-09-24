/**
 * terminal-stream (unit C4) — the fetch-based SSE reader: frames split across
 * chunks, the read-client HEADER (never a query proof), resume by `after`,
 * reconnect on a dropped connection, renew once on 401, stop on 404.
 */
import { describe, expect, it, vi } from 'vitest';
import type { VerseTerminalFrame } from '../../../../data/api-types.js';
import { openTerminalStream, parseTerminalSseBlock, type TerminalStreamState } from './terminal-stream.js';

function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

function response(status: number, chunks: string[] = []): Response {
  return new Response(status === 200 ? sseBody(chunks) : null, { status });
}

const frame = (seq: number, text: string) => `id: ${seq}\nevent: output\ndata: ${JSON.stringify({ type: 'output', seq, dataBase64: btoa(text) })}\n\n`;

describe('parseTerminalSseBlock', () => {
  it('reads output, title and exit frames; ignores comments and junk', () => {
    expect(parseTerminalSseBlock(frame(3, 'x').trim())).toEqual({ type: 'output', seq: 3, dataBase64: btoa('x') });
    expect(parseTerminalSseBlock('event: title\ndata: {"type":"title","title":"zsh"}')).toEqual({ type: 'title', title: 'zsh' });
    expect(parseTerminalSseBlock('event: exit\ndata: {"type":"exit","code":0,"signal":null}')).toEqual({ type: 'exit', code: 0, signal: null });
    expect(parseTerminalSseBlock(': keepalive')).toBeNull();
    expect(parseTerminalSseBlock('data: not json')).toBeNull();
    expect(parseTerminalSseBlock('data: {"type":"output"}')).toBeNull();
  });
});

describe('openTerminalStream', () => {
  it('sends the read-client header, parses frames split across chunks, and resumes after the last seq', async () => {
    const frames: VerseTerminalFrame[] = [];
    let lastSeq = 5;
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const whole = frame(6, 'ab') + frame(7, 'cd');
    const fetchFake = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), headers: init?.headers as Record<string, string> });
      if (calls.length === 1) return response(200, [': connected\n\n', whole.slice(0, 30), whole.slice(30)]);
      return new Promise<Response>(() => {}); // the reconnect hangs open
    });
    const stream = openTerminalStream('t-1', () => lastSeq, {
      onFrame: (f) => { frames.push(f); if (f.type === 'output') lastSeq = f.seq; },
    }, { fetch: fetchFake as unknown as typeof fetch, proof: () => 'p'.repeat(64), backoffMs: () => 0 });
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[0]!.url).toBe('/api/verse/terminal/t-1/stream?after=5');
    expect(calls[0]!.url).not.toContain('client=');
    expect(calls[0]!.headers['x-ashlr-read-client']).toBe('p'.repeat(64));
    expect(frames.map((f) => (f.type === 'output' ? atob(f.dataBase64) : f.type))).toEqual(['ab', 'cd']);
    // The server ended the stream: the reconnect resumes after what arrived.
    expect(calls[1]!.url).toBe('/api/verse/terminal/t-1/stream?after=7');
    stream.close();
  });

  it('a 404 means the tab is gone: it stops', async () => {
    const states: TerminalStreamState[] = [];
    const fetchFake = vi.fn(async () => response(404));
    openTerminalStream('t-1', () => 0, { onFrame: () => {}, onState: (s) => states.push(s) }, { fetch: fetchFake as unknown as typeof fetch, backoffMs: () => 0 });
    await vi.waitFor(() => expect(states).toContain('gone'));
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchFake).toHaveBeenCalledTimes(1);
  });

  it('a 401 renews the read session once and retries; a second 401 is "expired"', async () => {
    const states: TerminalStreamState[] = [];
    const fetchFake = vi.fn(async () => response(401));
    const renew = vi.fn(async () => true);
    openTerminalStream('t-1', () => 0, { onFrame: () => {}, onState: (s) => states.push(s) }, { fetch: fetchFake as unknown as typeof fetch, renew, backoffMs: () => 0 });
    await vi.waitFor(() => expect(states).toContain('expired'));
    expect(renew).toHaveBeenCalledTimes(1);
    expect(fetchFake).toHaveBeenCalledTimes(2);
  });

  it('a network error reconnects with backoff until closed', async () => {
    let n = 0;
    const fetchFake = vi.fn(async () => {
      n += 1;
      throw new TypeError('network');
    });
    const states: TerminalStreamState[] = [];
    const stream = openTerminalStream('t-1', () => 0, { onFrame: () => {}, onState: (s) => states.push(s) }, { fetch: fetchFake as unknown as typeof fetch, backoffMs: () => 1 });
    await vi.waitFor(() => expect(n).toBeGreaterThanOrEqual(3));
    stream.close();
    const after = n;
    await new Promise((r) => setTimeout(r, 20));
    expect(n).toBe(after);
    expect(states).toContain('reconnecting');
    expect(states.at(-1)).toBe('closed');
  });
});
